// THE REAL ADAPTERS — step 4's destination. Until this file was wired,
// registry.ts returned four refusing stubs; installLiveChainAdapters() swaps
// them for implementations built on the code MOVED from SamaPrime's lib/crypto.
//
// ⚠️ THE RESERVED STOP IN registry.ts IS SATISFIED, NOT IGNORED. It said: "DO
// NOT WIRE THE DERIVER UNTIL THE `reference` FORMAT IS DECIDED", because an
// address's reference is created at derivation time and is not recomputable —
// SamaPrime has already paid for that once. Ibrahim ruled the format on
// 2026-09-05 (`client:tenant:kind:id`), src/reference/index.ts implements it,
// and scripts/verify-reference-format.ts proves it. The condition is met.
import { Prisma, type Chain } from "@prisma/client";
import { prisma } from "@/db/client.js";
import logger from "@/log.js";
import type { AddressDeriver, ChainObserver, DerivedAddress, ObservedTransfer, TxExistenceProver } from "@/chain/types.js";
import { getChainAdapter } from "@/chain/impl/index.js";
import { deriveAddress } from "@/chain/hd/derive.js";
import { loadMasterSeed } from "@/chain/seed/master-seed.js";
import { transactionExistsOnChain } from "@/chain/impl/tx-existence.js";
import { setChainAdapters } from "@/chain/registry.js";

const log = logger.child({ mod: "chain/live" });

/** How many blocks a single tick will advance at most, so one call cannot run unbounded. */
const MAX_BLOCKS_PER_TICK = 2_000n;
/** ~10 minutes of Tron blocks / ~10 minutes of BSC blocks. See the first-run note in scan(). */
const FIRST_RUN_LOOKBACK = 200n;

/**
 * ⚠️ THE ONE CONVERSION THAT MIS-PRICES BY 1e12 IF IT IS WRONG.
 * BEP20 USDT has 18 decimals, TRC20 USDT has 6. A single hardcoded value for
 * both is SamaPrime's documented worst crypto defect. The divisor is read from
 * the ADAPTER for the chain being scanned — never from a constant here — and
 * scripts/verify-token-decimals-live.ts additionally reads decimals() from the
 * live contract and refuses if it disagrees with the configured value.
 */
export function rawToDecimalString(amountRaw: string, tokenDecimals: number): string {
  if (!/^\d+$/.test(amountRaw)) throw new Error(`amountRaw is not a non-negative integer string: ${amountRaw}`);
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 36) {
    throw new Error(`refusing to convert with implausible tokenDecimals=${tokenDecimals}`);
  }
  // Decimal, never a float: 1e18 does not survive a double.
  return new Prisma.Decimal(amountRaw).dividedBy(new Prisma.Decimal(10).pow(tokenDecimals)).toFixed();
}

// ── deriver ────────────────────────────────────────────────────────────────
export const liveDeriver: AddressDeriver = {
  async deriveNext(chain: Chain): Promise<DerivedAddress> {
    const seed = await loadMasterSeed();
    // The NEXT index for this chain. @@unique([chain, derivationIndex]) is what
    // actually prevents reuse — this read only picks a candidate, and a
    // concurrent caller losing the race gets a constraint violation rather than
    // a silently shared address.
    const highest = await prisma.address.findFirst({
      where: { chain }, orderBy: { derivationIndex: "desc" }, select: { derivationIndex: true },
    });
    const derivationIndex = (highest?.derivationIndex ?? -1) + 1;
    const address = deriveAddress(seed, chain, derivationIndex);
    log.info({ chain, derivationIndex }, "derived address"); // never the address itself at info
    return { chain, address, derivationIndex };
  },
};

// ── observer ───────────────────────────────────────────────────────────────
async function readCursor(chain: Chain): Promise<bigint | null> {
  const row = await prisma.scanCursor.findUnique({ where: { chain }, select: { lastScannedBlock: true } });
  return row ? row.lastScannedBlock : null;
}

/**
 * Record a range the observer did not scan. Open by default; closed only when
 * a later pass has demonstrably covered it, which the cursor does implicitly
 * by advancing past `toBlock`.
 */
async function recordGap(chain: Chain, fromBlock: bigint, toBlock: bigint, reason: string, evidence: string | null): Promise<void> {
  try {
    await prisma.scanGap.create({ data: { chain, fromBlock, toBlock, reason, ...(evidence !== null ? { evidence } : {}) } });
    log.warn({ chain, fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), reason }, "SCAN GAP recorded");
  } catch (e) {
    // A gap we cannot even record is worse than one we can; say so loudly
    // rather than letting the failure vanish into the caller's catch.
    log.error({ chain, err: e instanceof Error ? e.message : String(e) }, "FAILED TO RECORD SCAN GAP");
  }
}

/** Close any open gap the cursor has now demonstrably scanned past. */
async function closeCoveredGaps(chain: Chain, scannedThrough: bigint): Promise<void> {
  await prisma.scanGap.updateMany({
    where: { chain, closedAt: null, toBlock: { lte: scannedThrough } },
    data: { closedAt: new Date(), evidence: "covered by a later scan" },
  });
}

/** Monotonic: a late tick can never move the cursor backwards. */
async function advanceCursor(chain: Chain, to: bigint): Promise<void> {
  const updated = await prisma.scanCursor.updateMany({ where: { chain, lastScannedBlock: { lt: to } }, data: { lastScannedBlock: to } });
  if (updated.count === 0) {
    await prisma.scanCursor.upsert({ where: { chain }, create: { chain, lastScannedBlock: to }, update: {} });
  }
}

export const liveObserver: ChainObserver = {
  async scan(chain: Chain, addresses: ReadonlySet<string>): Promise<ObservedTransfer[]> {
    const adapter = getChainAdapter(chain);
    const head = await adapter.getLatestBlock();
    const cursor = await readCursor(chain);
    // First run on a fresh install starts AT HEAD, not at genesis: scanning the
    // whole chain would take days and would find nothing, because no address
    // existed before now. The cutover imports history separately.
    // ⚠️ FIRST RUN LOOKS BACK, IT DOES NOT START AT HEAD.
    // Starting exactly at head means a transfer that landed in the seconds
    // between "the address was registered" and "the observer's first tick" is
    // never scanned — and on a first live test that is precisely the window
    // somebody sends into. FIRST_RUN_LOOKBACK blocks of margin costs one extra
    // scan and closes it.
    const from = cursor === null ? (head > FIRST_RUN_LOOKBACK ? head - FIRST_RUN_LOOKBACK : 0n) : cursor + 1n;
    if (from > head) return [];
    const to = from + MAX_BLOCKS_PER_TICK - 1n > head ? head : from + MAX_BLOCKS_PER_TICK - 1n;

    let scan;
    try {
      scan = await adapter.getIncomingTransfers(from, to, new Set(addresses));
    } catch (err) {
      // ⚠️ THE WHOLE RANGE WAS MISSED AND THE CURSOR DOES NOT MOVE. The money is
      // safe — the next tick re-requests exactly this range. What is NOT safe is
      // the DIAGNOSIS: without a row here, "the deposit was missed" and "the
      // deposit never arrived" produce identical evidence. SamaPrime added its
      // gap table after its cursor went dark twice in two days, once on this
      // very provider.
      await recordGap(chain, from, to, "scan threw", err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 500) : String(err).slice(0, 500));
      throw err;
    }
    // Advance to what was ACTUALLY scanned, never to `to` — the adapter may
    // legitimately stop early, and reporting a block as scanned when it was not
    // is how a deposit is skipped forever.
    if (scan.scannedThrough >= from) { await advanceCursor(chain, scan.scannedThrough); await closeCoveredGaps(chain, scan.scannedThrough); }
    if (scan.stoppedEarly) {
      log.warn({ chain, ...scan.stoppedEarly }, "scan stopped early; cursor advanced only to scannedThrough");
      // The unscanned tail is a gap. It will be re-requested next tick, and the
      // row is what lets someone answer afterwards whether it ever was.
      if (scan.scannedThrough < to) await recordGap(chain, scan.scannedThrough + 1n, to, `stopped early: ${scan.stoppedEarly.reason}`.slice(0, 200), null);
    }

    return scan.transfers.map((t) => ({
      chain,
      txHash: t.txHash,
      toAddress: t.toAddress,
      amount: rawToDecimalString(t.amountRaw, adapter.tokenDecimals),
      blockNumber: t.blockNumber,
      confirmations: Number(head - t.blockNumber + 1n),
    }));
  },

  async confirmationsFor(chain: Chain, txHash: string): Promise<number> {
    return getChainAdapter(chain).getConfirmations(txHash);
  },
};

// ── existence prover ───────────────────────────────────────────────────────
export const liveProver: TxExistenceProver = {
  async exists(chain: Chain, txHash: string) {
    const known = await transactionExistsOnChain(chain, txHash);
    if (known) {
      const confirmations = await getChainAdapter(chain).getConfirmations(txHash);
      return { known: true, confirmed: confirmations > 0, confirmations, node: "rpc-pool" };
    }
    // ⚠️ DELIBERATELY REPORTS ONE NODE, NOT TWO. markRefunded requires >= 2
    // DISTINCT nodes to have answered before an absence is evidence, and the
    // ported helper does not yet report WHICH hosts replied. Returning a
    // single-element list keeps the reconciler's own guard doing its job
    // instead of being satisfied by a number this adapter cannot support.
    return { known: false, checkedAt: new Date(), nodes: ["rpc-pool"] };
  },
};

/**
 * Swap the refusing stubs for the real implementations.
 * ⚠️ THE SENDER IS DELIBERATELY NOT INSTALLED HERE. Sending requires the
 * two-factor vault to be UNLOCKED (getVaultSeed), and nothing in SamaPay has
 * unlocked it yet. A sender that throws VaultLockedError at the moment of a
 * withdrawal is worse than one that refuses by name up front, so it stays the
 * refusing stub until the vault path is proven end to end.
 */
export function installLiveChainAdapters(): void {
  setChainAdapters({ deriver: liveDeriver, observer: liveObserver, prover: liveProver });
  log.warn("live chain adapters installed: deriver, observer, prover. SENDER REMAINS REFUSING (vault not proven).");
}
