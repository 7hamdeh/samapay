// THE LEGACY HANDOFF'S CURSOR — contract §9 step 5b as amended by v1.1 A2.
// The one place that moves `scan_cursors` to a value that did NOT come from
// SamaPay's own scan, and the one place it may move BACKWARDS.
//
// Everywhere else the cursor only moves FORWARD (src/chain/live.ts
// advanceCursor, guarded by `last_scanned_block < new`). The handoff sets, per
// chain:
//
//     target = MIN(SamaPay cursor, MNTAD final cursor − SamaPay confirmation depth)
//
// MNTAD's final cursor n is its last FULLY scanned block (written by MNTAD's
// stop-legacy-scanner.ts). Subtracting SamaPay's own confirmation depth gives a
// margin for any difference between the two scanners' notion of "scanned"; if
// SamaPay's cursor c is already past that, SamaPay scanned those blocks WITHOUT
// the legacy addresses, so the cursor goes BACK. It never moves forward here.
// Re-scanning is safe for money: deposits are UNIQUE(chain, tx_hash), so a
// transfer SamaPay already recorded comes back `alreadyKnown`, never a second row.
//
// In the SAME transaction it stamps `scan_cursors.legacy_watch_enabled_at`
// (G6 schema). While that stamp is NULL the observer skips legacy_import
// addresses on the chain; once set, SamaPay watches them from the cursor on.
//
// REFUSED (planChain):
//   - a cursor file that is not EXACTLY {TRC20, BEP20, stoppedAt} (parseCursorFile);
//   - no legacy_import address on the chain (step 4 did not run);
//   - a target BELOW a deposit SamaPay already recorded at a legacy_import
//     address on the chain — rewinding past legacy history SamaPay owns.
// RE-RUNNABLE: a chain whose stamp is already set is left exactly as it is —
// the saved file can be pasted again with no effect, even after the observer
// has advanced the cursor.
//
// ⚠️ THE CONCURRENT TICK (v1.1 A11.1). Every observer tick must take the same
// per-chain advisory lock (cursorLockKey) and re-read the cursor and the stamp
// inside it before scanning-and-advancing; otherwise a tick in flight can push
// the cursor straight back past the target. That half is G2's (src/chain/live.ts
// / src/observer); this module only defines the lock name and takes it.
import { z } from "zod";
import type { Chain, Prisma } from "@prisma/client";

export const CHAINS: readonly Chain[] = ["TRC20", "BEP20"];

/** The advisory-lock key both the handoff and every observer tick take (A11.1). */
export function cursorLockKey(chain: Chain): string {
  return `samapay_scan_cursor:${chain}`;
}

/**
 * The cursor file MNTAD's scripts/ops/s2/stop-legacy-scanner.ts writes, EXACTLY:
 *   {"TRC20": <int>, "BEP20": <int>, "stoppedAt": "<ISO-8601>"}
 * Each number is MNTAD's final `last_scanned_block` for that chain. No other
 * key is accepted (strict), and neither chain is optional.
 */
const blockNumber = z.number().int().nonnegative();
export const CursorFileSchema = z.object({
  TRC20: blockNumber,
  BEP20: blockNumber,
  stoppedAt: z.iso.datetime({ offset: true }),
}).strict();
export type CursorFile = z.infer<typeof CursorFileSchema>;

export class LegacyWatchRefused extends Error {
  constructor(readonly chain: Chain | null, message: string) { super(message); this.name = "LegacyWatchRefused"; }
}

/** MIN(current, mntadFinal − depth), floored at 0. No SamaPay cursor yet → mntadFinal − depth. */
export function handoffTarget(current: bigint | null, mntadFinal: bigint, depth: bigint): bigint {
  const fromMntad = mntadFinal > depth ? mntadFinal - depth : 0n;
  return current !== null && current < fromMntad ? current : fromMntad;
}

export interface ChainPlan {
  chain: Chain;
  mntadFinal: bigint;
  current: bigint | null;
  target: bigint;
  /** Blocks (target, current] SamaPay will scan again — 0n when the cursor stays. */
  rescan: bigint;
  legacyAddresses: number;
  /** Legacy watch already on for this chain: nothing is written (re-run). */
  alreadyEnabledAt: Date | null;
}

/** Parses and validates the cursor file's content. Throws LegacyWatchRefused on any shape error. */
export function parseCursorFile(raw: string): CursorFile {
  let json: unknown;
  try { json = JSON.parse(raw); } catch { throw new LegacyWatchRefused(null, "cursor file is not JSON"); }
  if (json && typeof json === "object") {
    for (const chain of CHAINS) {
      if (!(chain in json)) throw new LegacyWatchRefused(chain, `cursor file has no ${chain} block — refusing to start legacy watch on one chain only`);
    }
  }
  const parsed = CursorFileSchema.safeParse(json);
  if (!parsed.success) throw new LegacyWatchRefused(null, `cursor file does not match {TRC20, BEP20, stoppedAt}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

/** Takes the per-chain cursor lock for the rest of the transaction. */
export async function lockCursor(tx: Prisma.TransactionClient, chain: Chain): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${cursorLockKey(chain)}))`;
}

/** What the handoff would do on one chain, refusing on every rule in the header. Call under lockCursor. */
export async function planChain(tx: Prisma.TransactionClient, chain: Chain, mntadFinal: bigint, depth: bigint): Promise<ChainPlan> {
  const cursor = await tx.scanCursor.findUnique({ where: { chain }, select: { lastScannedBlock: true, legacyWatchEnabledAt: true } });
  const legacyAddresses = await tx.address.count({ where: { chain, legacyImport: true } });
  if (legacyAddresses === 0) throw new LegacyWatchRefused(chain, `no legacy_import addresses on ${chain} — run scripts/import-legacy-addresses.ts first`);
  const current = cursor?.lastScannedBlock ?? null;
  if (cursor?.legacyWatchEnabledAt) {
    return { chain, mntadFinal, current, target: current!, rescan: 0n, legacyAddresses, alreadyEnabledAt: cursor.legacyWatchEnabledAt };
  }
  const target = handoffTarget(current, mntadFinal, depth);
  const newestLegacy = await tx.deposit.findFirst({
    where: { chain, address: { legacyImport: true }, blockNumber: { not: null } },
    orderBy: { blockNumber: "desc" }, select: { blockNumber: true },
  });
  if (newestLegacy?.blockNumber != null && target < newestLegacy.blockNumber) {
    throw new LegacyWatchRefused(chain, `${chain}: target block ${target} is below block ${newestLegacy.blockNumber}, where SamaPay already recorded a deposit at a legacy address — refusing to move the cursor backwards past existing SamaPay data`);
  }
  const rescan = current !== null && current > target ? current - target : 0n;
  return { chain, mntadFinal, current, target, rescan, legacyAddresses, alreadyEnabledAt: null };
}

/**
 * Sets the cursor to `plan.target` — which is never above the current cursor —
 * and stamps legacy watch on. Its own write, NEVER live.ts's monotonic
 * advanceCursor. Call under lockCursor, with a plan from planChain in the same tx.
 */
export async function setCursorAndEnableLegacyWatch(tx: Prisma.TransactionClient, plan: ChainPlan, at: Date): Promise<void> {
  if (plan.alreadyEnabledAt) return;
  if (plan.current !== null && plan.target > plan.current) throw new LegacyWatchRefused(plan.chain, `refusing to move ${plan.chain} forward (${plan.current} -> ${plan.target}); the handoff only moves back or stays`);
  await tx.scanCursor.upsert({
    where: { chain: plan.chain },
    create: { chain: plan.chain, lastScannedBlock: plan.target, legacyWatchEnabledAt: at },
    update: { lastScannedBlock: plan.target, legacyWatchEnabledAt: at },
  });
}
