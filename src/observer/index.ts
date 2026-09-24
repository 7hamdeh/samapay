// *** THE ONLY WRITER OF `deposits`. *** value-model's structural suite greps
// src/ for deposit writes with this directory as its present-control; a
// `deposit.create` anywhere else is a defect by definition.
//
// What it does: takes a ChainObserver (interface; the real scanner moves in
// at step 4) and the set of addresses SamaPay has issued, records every
// transfer to one of them ONCE (UNIQUE(chain, tx_hash) makes a second
// record impossible, not merely unlikely), and promotes `detected` →
// `confirmed` exactly once when confirmations reach the chain's threshold —
// setting credited_at, stamping the fee, appending the audit row and
// enqueuing the event in the same transaction. Allowance is never written
// here: it is READ from confirmed rows by src/allowance.
//
// PHASE 0 (contract §4, §9 and v1.1 amendments A1, A2, A3, A7, A9, A11):
// - EVERY TICK HOLDS THE CHAIN'S CURSOR ADVISORY LOCK (cursorLockKey), the
//   same lock scripts/ops/start-legacy-watch.ts (src/chain/cursor.ts) takes to
//   rewind the cursor and enable legacy watching. Inside it the tick re-reads
//   legacy_watch_enabled_at and the address set, then scans and advances. A
//   rewind/enable therefore lands strictly BEFORE or strictly AFTER a tick,
//   never in the middle — a tick that read "legacy off" can never carry the
//   cursor past the range the rewind reopened for the legacy addresses.
// - An address with `watch_disabled_at` set is NOT watched: not handed to
//   the scan, a transfer to it is not recorded, a deposit already detected
//   there is not promoted. The row stays (§9 step 0).
// - `legacy_import` addresses are watched only once the chain's scan cursor
//   carries `legacy_watch_enabled_at` (§9 step 5b, A3): until then MNTAD's
//   scanner owns them, and two watchers is a double credit.
// - Amounts are TRUNCATED to 6 dp at this boundary, never rounded half-up by
//   the Decimal(18,6) column (A7; BEP20 USDT has 18 token decimals).
// - `deposit.confirmed` for EVERY confirmed deposit, intent addresses too
//   (A1: the store credits per deposit), with the fee stamped on the row.
// - After recording and confirming, every open intent on the chain with a
//   deposit is re-decided by src/intents/state.ts (advanceIntentsForChain),
//   which emits the payment_intent.* status events.
import { Prisma, type Chain } from "@prisma/client";
import { prisma } from "@/db/client.js";
import { appendAudit } from "@/audit/append.js";
import { feeForConfirmation } from "@/allowance/fee.js";
import { eventSink } from "@/intents/events-port.js";
import { advanceIntentsForChain } from "@/intents/sweep.js";
import type { ChainObserver, ObservedTransfer } from "@/chain/types.js";

export interface ObserveResult { seen: number; recorded: number; alreadyKnown: number; confirmed: number; unknownAddress: number; intentsAdvanced: number }

/** The per-chain cursor lock. MUST equal the name src/chain/cursor.ts (G5) takes for rewind/enable. */
export function cursorLockKey(chain: Chain): string { return `samapay_scan_cursor:${chain}`; }
/** A tick holds the lock across the scan (RPC); bounded so a hung RPC cannot hold it forever. */
const TICK_TIMEOUT_MS = 10 * 60_000;
const LOCK_WAIT_MS = 60_000;

/**
 * One tick for one chain. Safe to call again with the same transfers:
 * nothing double-writes. Two concurrent ticks on one chain serialise on the
 * cursor lock.
 *
 * `requiredConfirmations` is an explicit parameter, not a module constant —
 * the caller (worker/index.ts) reads it from `getChainConfig(chain)
 * .confirmationsRequired`, the SAME call `chain/live.ts` makes for its
 * scan-window cap. There is no second definition inside this module left to
 * drift out of sync with that one (docs/confirmation-depth-divergence-2026-09-07.md).
 */
export async function observeChain(chain: Chain, observer: ChainObserver, requiredConfirmations: number): Promise<ObserveResult> {
  return prisma.$transaction(async (lockTx) => {
    await lockTx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${cursorLockKey(chain)}))`;
    // Re-read INSIDE the lock: what a rewind/enable just committed is what this tick sees.
    const cursor = await lockTx.scanCursor.findUnique({ where: { chain }, select: { legacyWatchEnabledAt: true } });
    const addresses = await lockTx.address.findMany({
      where: { chain, ...watchedAddressWhere(cursor?.legacyWatchEnabledAt != null) },
      select: { id: true, address: true, keyId: true },
    });
    // ⚠️ CASE IS NOT A FREE NORMALISATION ACROSS CHAINS.
    // BEP20 addresses are hex and case-insensitive (the mixed case is only an
    // EIP-55 checksum). TRON addresses are BASE58 and CASE-SIGNIFICANT —
    // lowercasing one produces a string that is not an address at all. This
    // code lowercased both and the Tron adapter answered "Invalid address
    // provided" on every tick, which is the good outcome; the bad one is a
    // chain where the corrupted form is still VALID and simply matches nothing.
    const key = (a: string) => (chain === "BEP20" ? a.toLowerCase() : a);
    const byAddress = new Map(addresses.map((a) => [key(a.address), a]));
    // The adapter receives addresses EXACTLY as stored, never a normalised form.
    const transfers = await observer.scan(chain, new Set(addresses.map((a) => a.address)));
    const result: ObserveResult = { seen: transfers.length, recorded: 0, alreadyKnown: 0, confirmed: 0, unknownAddress: 0, intentsAdvanced: 0 };
    for (const t of transfers) {
      const outcome = await recordTransfer(chain, t, byAddress.get(key(t.toAddress)));
      result[outcome]++;
    }
    result.confirmed += await promoteConfirmed(chain, observer, requiredConfirmations);
    result.intentsAdvanced = (await advanceIntentsForChain(chain, { now: new Date(), confirmationsRequired: requiredConfirmations })).advanced;
    return result;
  }, { timeout: TICK_TIMEOUT_MS, maxWait: LOCK_WAIT_MS });
}

/** The addresses this observer watches: never a disabled one; legacy imports only once their watch is enabled. */
function watchedAddressWhere(legacyWatchEnabled: boolean): Prisma.AddressWhereInput {
  return { watchDisabledAt: null, ...(legacyWatchEnabled ? {} : { legacyImport: false }) };
}

/** Token units → at most 6 dp, rounded DOWN (never half-up by the column). */
export function truncateAmount(amount: string): Prisma.Decimal {
  const d = new Prisma.Decimal(amount);
  if (!d.isFinite() || d.isNegative()) throw new Error(`observed amount is not a non-negative decimal: ${amount}`);
  return d.toDecimalPlaces(6, Prisma.Decimal.ROUND_DOWN);
}

async function recordTransfer(chain: Chain, t: ObservedTransfer, target: { id: string; keyId: string } | undefined): Promise<"recorded" | "alreadyKnown" | "unknownAddress"> {
  if (!target) return "unknownAddress";
  const amount = truncateAmount(t.amount);
  try {
    await prisma.$transaction(async (tx) => {
      const row = await tx.deposit.create({
        data: { keyId: target.keyId, addressId: target.id, chain, txHash: t.txHash, amount, confirmations: t.confirmations, status: "detected", blockNumber: t.blockNumber },
        select: { id: true },
      });
      await appendAudit(tx, { keyId: target.keyId, actor: "observer", action: "deposit.detected", subjectId: row.id, params: { chain, txHash: t.txHash, amount: amount.toFixed(), observedAmount: t.amount, block: t.blockNumber.toString() } });
    });
    return "recorded";
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return "alreadyKnown"; // UNIQUE(chain, tx_hash): the structural one-credit rule
    throw e;
  }
}

const DEPOSIT_SNAPSHOT_SELECT = {
  id: true, chain: true, txHash: true, amount: true, confirmations: true, status: true, detectedAt: true, creditedAt: true,
  address: { select: { address: true, reference: true, intent: { select: { id: true, reference: true } } } },
} as const satisfies Prisma.DepositSelect;

/** The contract §4 Deposit as at event time. Public id `dep_<row id>` (the events objectId). */
export function renderDepositSnapshot(d: Prisma.DepositGetPayload<{ select: typeof DEPOSIT_SNAPSHOT_SELECT }>): Record<string, unknown> {
  return {
    id: `dep_${d.id}`, object: "deposit", status: d.status, chain: d.chain, tx_hash: d.txHash, amount: d.amount.toFixed(),
    confirmations: d.confirmations, address: d.address.address,
    // An intent's address carries payment_intent:<id> internally; the store's reference is the intent's.
    reference: d.address.intent?.reference ?? d.address.reference,
    payment_intent_id: d.address.intent?.id ?? null,
    detected_at: d.detectedAt.toISOString(), confirmed_at: d.creditedAt?.toISOString() ?? null,
  };
}

/** detected → confirmed, once. The status guard in the WHERE is what makes "once" true under concurrency. */
async function promoteConfirmed(chain: Chain, observer: ChainObserver, requiredConfirmations: number): Promise<number> {
  const pending = await prisma.deposit.findMany({ where: { chain, status: "detected", address: { watchDisabledAt: null } }, select: { id: true, keyId: true, txHash: true, amount: true } });
  let promoted = 0;
  for (const d of pending) {
    const confirmations = await observer.confirmationsFor(chain, d.txHash);
    if (confirmations < requiredConfirmations) { await prisma.deposit.update({ where: { id: d.id }, data: { confirmations } }); continue; }
    await prisma.$transaction(async (tx) => {
      const feeAmount = await feeForConfirmation(tx, d.keyId, d.amount);
      const flipped = await tx.deposit.updateMany({ where: { id: d.id, status: "detected" }, data: { status: "confirmed", confirmations, creditedAt: new Date(), feeAmount } });
      if (flipped.count !== 1) return; // someone else confirmed it first; nothing to do, nothing to audit twice
      promoted++;
      await appendAudit(tx, { keyId: d.keyId, actor: "observer", action: "deposit.confirmed", subjectId: d.id, params: { chain, txHash: d.txHash, amount: d.amount.toString(), feeAmount: feeAmount.toFixed(), confirmations } });
      const row = await tx.deposit.findUniqueOrThrow({ where: { id: d.id }, select: DEPOSIT_SNAPSHOT_SELECT });
      // A1: every confirmed deposit, intent addresses included — the store credits per deposit.
      await eventSink()(tx, { type: "deposit.confirmed", objectKind: "deposit", objectId: `dep_${d.id}`, snapshot: renderDepositSnapshot(row) });
    });
  }
  return promoted;
}

// ── /v1/health readers (A2, A9; G1 wires the route) ─────────────────────────
const CHAINS: readonly Chain[] = ["TRC20", "BEP20"];

/** legacy_watch: when SamaPay started watching each chain's legacy_import addresses, or null. */
export async function legacyWatchStatus(): Promise<Record<Chain, string | null>> {
  const rows = await prisma.scanCursor.findMany({ select: { chain: true, legacyWatchEnabledAt: true } });
  const out: Record<Chain, string | null> = { TRC20: null, BEP20: null };
  for (const r of rows) out[r.chain] = r.legacyWatchEnabledAt?.toISOString() ?? null;
  return out;
}

/** observer_lag_blocks: chain head − last scanned block; null when there is no cursor yet or the head is unreadable. */
export async function observerLagBlocks(head: (chain: Chain) => Promise<bigint>): Promise<Record<Chain, number | null>> {
  const rows = await prisma.scanCursor.findMany({ select: { chain: true, lastScannedBlock: true } });
  const out: Record<Chain, number | null> = { TRC20: null, BEP20: null };
  for (const chain of CHAINS) {
    const cur = rows.find((r) => r.chain === chain);
    if (!cur) continue;
    try { const h = await head(chain); out[chain] = Number(h > cur.lastScannedBlock ? h - cur.lastScannedBlock : 0n); }
    catch { out[chain] = null; }
  }
  return out;
}
