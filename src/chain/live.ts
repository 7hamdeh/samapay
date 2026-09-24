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
import type { AddressDeriver, ChainObserver, DerivedAddress, ScanBatch, TxExistenceProver } from "@/chain/types.js";
import { getChainAdapter } from "@/chain/impl/index.js";
import { getChainConfig } from "@/chain/impl/config.js";
import { deriveAddress } from "@/chain/hd/derive.js";
import { loadMasterSeed } from "@/chain/seed/master-seed.js";
import { transactionExistsOnChain } from "@/chain/impl/tx-existence.js";
import { setChainAdapters } from "@/chain/registry.js";
import { derivationFloor, nextIndexAboveFloor } from "@/chain/derivation-floor.js";

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
    // ⚠️ THE FLOOR FIRST, BEFORE THE SEED IS EVEN LOADED. Under decision #80
    // SamaPay derives from MNTAD's seed; every index at or below the floor may
    // already be a customer's address there. Unset or invalid → refuse.
    const floor = derivationFloor(chain);
    const seed = await loadMasterSeed();
    // The NEXT index for this chain. @@unique([chain, derivationIndex]) is what
    // actually prevents reuse — this read only picks a candidate, and a
    // concurrent caller losing the race gets a constraint violation rather than
    // a silently shared address.
    const highest = await prisma.address.findFirst({
      where: { chain }, orderBy: { derivationIndex: "desc" }, select: { derivationIndex: true },
    });
    const derivationIndex = nextIndexAboveFloor(highest?.derivationIndex ?? null, floor);
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

export const liveObserver: ChainObserver = {
  // ⚠️ READS THE CURSOR, NEVER WRITES IT. This used to advance the cursor here,
  // BEFORE the observer recorded the transfers it returned: one failed insert
  // (a DB blip, a constraint, a bad amount) and that deposit — and the rest of
  // the batch — was behind the cursor forever (Q's probe: 5 USDT at block 150,
  // cursor already 982, nothing ever recorded). The observer now advances to
  // `scannedThrough`, under the cursor lock, after every record succeeded.
  async scan(chain: Chain, addresses: ReadonlySet<string>): Promise<ScanBatch> {
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
    // ⚠️ NEVER SCAN SHALLOWER THAN THE CONFIRMATION DEPTH. THIS IS THE 2026-09-07 BUG.
    // The adapter asks TronGrid for CONFIRMED transfers (`only_confirmed=true`).
    // Ask that about a block seconds old and the honest answer is an EMPTY LIST —
    // which is byte-identical to "this block contains no transfers to you". The
    // cursor then advances past a real deposit and never comes back.
    // MEASURED: a 3.010000 USDT transfer in block 86022515 was invisible at depth 0
    // and is found by this same code at depth 177.
    // Read from getChainConfig(), never a copied literal or a second constant:
    // this MUST be the exact number promoteConfirmed() credits on (observer/
    // index.ts), or the two halves drift and the check stops checking — see
    // docs/confirmation-depth-divergence-2026-09-07.md, closed by this change.
    const safeHead = head - BigInt(getChainConfig(chain).confirmationsRequired) + 1n;
    const from = cursor === null ? (head > FIRST_RUN_LOOKBACK ? head - FIRST_RUN_LOOKBACK : 0n) : cursor + 1n;
    if (from > safeHead) return { transfers: [], scannedThrough: null };
    const to = from + MAX_BLOCKS_PER_TICK - 1n > safeHead ? safeHead : from + MAX_BLOCKS_PER_TICK - 1n;

    const scan = await adapter.getIncomingTransfers(from, to, new Set(addresses));
    // Report what was ACTUALLY scanned, never `to` — the adapter may
    // legitimately stop early, and reporting a block as scanned when it was not
    // is how a deposit is skipped forever.
    if (scan.stoppedEarly) {
      log.warn({ chain, ...scan.stoppedEarly }, "scan stopped early; cursor will advance only to scannedThrough");
    }

    const transfers = scan.transfers.map((t) => ({
      chain,
      txHash: t.txHash,
      toAddress: t.toAddress,
      amount: rawToDecimalString(t.amountRaw, adapter.tokenDecimals),
      blockNumber: t.blockNumber,
      confirmations: Number(head - t.blockNumber + 1n),
    }));
    return { transfers, scannedThrough: scan.scannedThrough >= from ? scan.scannedThrough : null };
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
/**
 * The API process's half: the DERIVER only (POST /addresses, POST
 * /payment-intents). The observer and prover belong to the worker; the sender
 * stays refusing everywhere (see below). Call after assertDerivationFloorsConfigured().
 */
export function installLiveDeriver(): void {
  setChainAdapters({ deriver: liveDeriver });
  log.warn("live deriver installed (index floor enforced).");
}

export function installLiveChainAdapters(): void {
  setChainAdapters({ deriver: liveDeriver, observer: liveObserver, prover: liveProver });
  log.warn("live chain adapters installed: deriver, observer, prover. SENDER REMAINS REFUSING (vault not proven).");
}
