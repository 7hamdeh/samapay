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
import type { ChainObserver, ObservedTransfer, ScanBatch } from "@/chain/types.js";
import { DEPOSIT_RENDER_SELECT, publicDepositId, renderDeposit } from "@/render/deposit.js";
import { cursorLockKey } from "@/chain/cursor.js";
import { getChainAdapter } from "@/chain/impl/index.js";
import logger from "@/log.js";

const log = logger.child({ mod: "observer" });

export interface ObserveResult { seen: number; recorded: number; alreadyKnown: number; confirmed: number; unknownAddress: number; intentsAdvanced: number; quarantined: number }

// ── POISON TRANSFERS (Q's recheck, lead ruling 2026-09-25) ────────────────────
// Record-first (B1) means ONE transfer whose insert fails DETERMINISTICALLY
// (a malformed amount, say) would hold the chain's cursor for ever and stall
// every later deposit. After POISON_AFTER consecutive tick failures on the
// same (chain, tx), the transfer is QUARANTINED: a scan_gaps row (existing
// columns only — from/to = its block, reason, evidence = the tx and the error)
// is written ON THE LOCK TRANSACTION, so it commits together with the cursor
// advance past it, and an error-level alert is logged. The money is not lost:
// the gap stays OPEN (closed_at NULL) for manual handling. The count is per
// process; a restart only means a few more retries before quarantine.
export const POISON_AFTER = 3;
export const POISON_GAP_REASON = "poison_transfer";
const failures = new Map<string, number>();

// The per-chain cursor lock is src/chain/cursor.ts's (G5): ONE definition for the tick and the handoff.
export { cursorLockKey };
/** A tick holds the lock across the scan (RPC); bounded so a hung RPC cannot hold it forever. */
const TICK_TIMEOUT_MS = 10 * 60_000;
const LOCK_WAIT_MS = 60_000;
/** The JS work stops this long before Prisma would time the lock transaction out. */
const DEADLINE_MARGIN_MS = 60_000;

export class TickDeadlineExceeded extends Error {
  constructor(chain: Chain) { super(`observer tick for ${chain} ran past its deadline; stopped before the lock could lapse`); this.name = "TickDeadlineExceeded"; }
}

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
    // The work and the lock END TOGETHER: every step checks the deadline, so the
    // tick throws before Prisma times the transaction out and releases the lock
    // under a still-running tick (Q M2). The cursor advance itself runs ON
    // lockTx, so it cannot happen at all once that transaction is gone.
    const deadline = Date.now() + TICK_TIMEOUT_MS - DEADLINE_MARGIN_MS;
    const inTime = () => { if (Date.now() > deadline) throw new TickDeadlineExceeded(chain); };
    // Re-read INSIDE the lock: what a rewind/enable just committed is what this tick sees.
    const cursor = await lockTx.scanCursor.findUnique({ where: { chain }, select: { legacyWatchEnabledAt: true } });
    const addresses = await lockTx.address.findMany({
      where: { chain, ...watchedAddressWhere(cursor?.legacyWatchEnabledAt != null) },
      select: { id: true, address: true, keyId: true, key: { select: { clientId: true } } },
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
    const scanned = await observer.scan(chain, new Set(addresses.map((a) => a.address)));
    const batch: ScanBatch = Array.isArray(scanned) ? { transfers: scanned, scannedThrough: null } : scanned;
    const result: ObserveResult = { seen: batch.transfers.length, recorded: 0, alreadyKnown: 0, confirmed: 0, unknownAddress: 0, intentsAdvanced: 0, quarantined: 0 };
    // RECORD FIRST. Any failure throws out of the tick with the cursor where it
    // was, and the next tick scans the same range again — UNIQUE(chain, tx_hash)
    // makes the re-scan safe (Q's review B1).
    for (const t of batch.transfers) {
      inTime();
      const fkey = `${chain}:${t.txHash}`;
      try {
        const outcome = await recordTransfer(chain, t, byAddress.get(key(t.toAddress)));
        result[outcome]++;
        failures.delete(fkey);
      } catch (e) {
        const n = (failures.get(fkey) ?? 0) + 1;
        failures.set(fkey, n);
        if (n < POISON_AFTER) throw e; // not yet: no advance, the next tick re-scans
        await quarantineTransfer(lockTx, chain, t, e, n);
        failures.delete(fkey);
        result.quarantined++;
      }
    }
    // THEN the cursor — only now that every transfer in the range is recorded or already known.
    inTime();
    if (batch.scannedThrough !== null) await advanceCursor(lockTx, chain, batch.scannedThrough);
    result.confirmed += await promoteConfirmed(chain, observer, requiredConfirmations, inTime);
    inTime();
    result.intentsAdvanced = (await advanceIntentsForChain(chain, { now: new Date(), confirmationsRequired: requiredConfirmations })).advanced;
    return result;
  }, { timeout: TICK_TIMEOUT_MS, maxWait: LOCK_WAIT_MS });
}

/** A scan_gaps row for a transfer that failed POISON_AFTER ticks in a row. Idempotent per (chain, block, tx). */
async function quarantineTransfer(lockTx: Prisma.TransactionClient, chain: Chain, t: ObservedTransfer, e: unknown, failuresSoFar: number): Promise<void> {
  const error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  const evidence = JSON.stringify({ txHash: t.txHash, toAddress: t.toAddress, amount: t.amount, blockNumber: t.blockNumber.toString(), failures: failuresSoFar, error: error.slice(0, 1000) });
  const open = await lockTx.scanGap.findFirst({ where: { chain, fromBlock: t.blockNumber, toBlock: t.blockNumber, reason: POISON_GAP_REASON, closedAt: null, evidence: { contains: t.txHash } }, select: { id: true } });
  if (!open) await lockTx.scanGap.create({ data: { chain, fromBlock: t.blockNumber, toBlock: t.blockNumber, reason: POISON_GAP_REASON, evidence } });
  log.error({ actor: "observer", action: "deposit.quarantine", result: "scan_gap_opened", chain, txHash: t.txHash, block: t.blockNumber.toString(), failures: failuresSoFar, err: error }, "ALERT: transfer could not be recorded after repeated ticks; quarantined in scan_gaps for manual handling, cursor moves past it");
}

/** Monotonic: a late tick can never move the cursor backwards. On the LOCK transaction. */
async function advanceCursor(lockTx: Prisma.TransactionClient, chain: Chain, to: bigint): Promise<void> {
  const updated = await lockTx.scanCursor.updateMany({ where: { chain, lastScannedBlock: { lt: to } }, data: { lastScannedBlock: to } });
  if (updated.count === 0) await lockTx.scanCursor.upsert({ where: { chain }, create: { chain, lastScannedBlock: to }, update: {} });
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

async function recordTransfer(chain: Chain, t: ObservedTransfer, target: { id: string; keyId: string; key: { clientId: string } } | undefined): Promise<"recorded" | "alreadyKnown" | "unknownAddress"> {
  if (!target) return "unknownAddress";
  const amount = truncateAmount(t.amount);
  try {
    await prisma.$transaction(async (tx) => {
      const row = await tx.deposit.create({
        data: { keyId: target.keyId, clientId: target.key.clientId, addressId: target.id, chain, txHash: t.txHash, amount, confirmations: t.confirmations, status: "detected", blockNumber: t.blockNumber },
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

/** detected → confirmed, once. The status guard in the WHERE is what makes "once" true under concurrency. */
async function promoteConfirmed(chain: Chain, observer: ChainObserver, requiredConfirmations: number, inTime: () => void): Promise<number> {
  const pending = await prisma.deposit.findMany({ where: { chain, status: "detected", address: { watchDisabledAt: null } }, select: { id: true, keyId: true, txHash: true, amount: true } });
  let promoted = 0;
  for (const d of pending) {
    inTime();
    const confirmations = await observer.confirmationsFor(chain, d.txHash);
    if (confirmations < requiredConfirmations) { await prisma.deposit.update({ where: { id: d.id }, data: { confirmations } }); continue; }
    await prisma.$transaction(async (tx) => {
      const feeAmount = await feeForConfirmation(tx, d.keyId, d.amount);
      const flipped = await tx.deposit.updateMany({ where: { id: d.id, status: "detected" }, data: { status: "confirmed", confirmations, creditedAt: new Date(), feeAmount } });
      if (flipped.count !== 1) return; // someone else confirmed it first; nothing to do, nothing to audit twice
      promoted++;
      await appendAudit(tx, { keyId: d.keyId, actor: "observer", action: "deposit.confirmed", subjectId: d.id, params: { chain, txHash: d.txHash, amount: d.amount.toString(), feeAmount: feeAmount.toFixed(), confirmations } });
      const row = await tx.deposit.findUniqueOrThrow({ where: { id: d.id }, select: DEPOSIT_RENDER_SELECT });
      // A1: every confirmed deposit, intent addresses included — the store credits per deposit.
      // The snapshot is G1's renderDeposit, the SAME function GET /v1/deposits/:id renders with (A13).
      await eventSink()(tx, { type: "deposit.confirmed", objectKind: "deposit", objectId: publicDepositId(d.id), snapshot: { ...renderDeposit(row) } });
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

const liveHead = (chain: Chain) => getChainAdapter(chain).getLatestBlock();

/** observer_lag_blocks: chain head − last scanned block; null when there is no cursor yet or the head is unreadable. */
export async function observerLagBlocks(head: (chain: Chain) => Promise<bigint> = liveHead): Promise<Record<Chain, number | null>> {
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
