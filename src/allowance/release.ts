import { NotReleasable, type Tx } from "./types.js";

/**
 * Release a reservation that was never broadcast: pending → cancelled,
 * held → released. The ONLY way a pending row stops consuming before a
 * send is attempted. Status-guarded in the WHERE so a concurrent sender
 * that has already moved the row to `sending` wins and this refuses —
 * never a read-then-write.
 *
 * Called by the sender (local failure after reserve) and by the
 * reconciler; never by a route. The caller appends the audit event.
 */
export async function release(tx: Tx, reservationId: string, reason: string): Promise<{ withdrawalId: string }> {
  const res = await tx.reservation.findUnique({ where: { id: reservationId }, select: { withdrawalId: true, status: true } });
  if (!res) throw new NotReleasable(reservationId, "missing");
  const flipped = await tx.withdrawal.updateMany({
    where: { id: res.withdrawalId, status: "pending" },
    data: { status: "cancelled", resolvedAt: new Date() },
  });
  if (flipped.count !== 1) {
    const w = await tx.withdrawal.findUnique({ where: { id: res.withdrawalId }, select: { status: true } });
    throw new NotReleasable(res.withdrawalId, w?.status ?? "missing");
  }
  await tx.reservation.update({ where: { id: reservationId }, data: { status: "released", releasedAt: new Date(), reason } });
  return { withdrawalId: res.withdrawalId };
}
