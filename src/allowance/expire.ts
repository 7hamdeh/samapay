import { type Tx } from "./types.js";

/**
 * Expire reservations that were never broadcast: every `pending`
 * withdrawal whose reservation is still `held` and older than
 * `olderThan` → expired / expired. An explicit, audited transition —
 * NEVER a timer property read at aggregate time. Returns the ids so the
 * caller can append one audit event per row.
 *
 * Called by the reconciler only.
 */
export async function expire(tx: Tx, olderThan: Date): Promise<{ withdrawalIds: string[] }> {
  const stale = await tx.reservation.findMany({
    where: { status: "held", createdAt: { lt: olderThan }, withdrawal: { status: "pending" } },
    select: { id: true, withdrawalId: true },
  });
  const ids: string[] = [];
  for (const r of stale) {
    // Status-guarded per row: a sender that claimed the row meanwhile wins.
    const flipped = await tx.withdrawal.updateMany({ where: { id: r.withdrawalId, status: "pending" }, data: { status: "expired", resolvedAt: new Date() } });
    if (flipped.count !== 1) continue;
    await tx.reservation.update({ where: { id: r.id }, data: { status: "expired", releasedAt: new Date(), reason: `expired: older than ${olderThan.toISOString()}` } });
    ids.push(r.withdrawalId);
  }
  return { withdrawalIds: ids };
}
