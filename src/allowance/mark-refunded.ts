import { Prisma } from "@prisma/client";
import { NotRefundable, RefundNeedsEvidence, type Tx } from "./types.js";

/**
 * The evidence that a broadcast attempt did NOT land. Without it a
 * `failed` or `send_unknown` row keeps consuming — clause 2. The absence
 * proof is stored BESIDE the transition (withdrawals.evidence, jsonb), not
 * only in the audit row, so the restore can be audited from the row.
 */
export interface AbsenceEvidence {
  /** How the absence was established, e.g. "getTransactionReceipt on 2 endpoints". */
  checkedVia: string;
  /** The candidate hash(es) that were looked for and NOT found. */
  txHashesChecked: string[];
  /** ISO time of the check. */
  checkedAt: string;
  /** Must be literally true; a caller that cannot assert it cannot refund. */
  absentOnChain: true;
}

/**
 * failed | send_unknown → refunded. The ONLY transition that restores an
 * allowance after a send was attempted, and it requires the on-chain
 * absence proof. A timeout is not evidence. Called by the sender or the
 * reconciler after their own tx-existence check; never by a route.
 */
export async function markRefunded(tx: Tx, withdrawalId: string, evidence: AbsenceEvidence): Promise<void> {
  if (!evidence || evidence.absentOnChain !== true) throw new RefundNeedsEvidence(withdrawalId, "absentOnChain must be true");
  if (!evidence.checkedVia || !evidence.checkedAt) throw new RefundNeedsEvidence(withdrawalId, "checkedVia and checkedAt are required");
  if (!Array.isArray(evidence.txHashesChecked)) throw new RefundNeedsEvidence(withdrawalId, "txHashesChecked must be a list (may be empty when nothing was ever broadcast)");

  const flipped = await tx.withdrawal.updateMany({
    where: { id: withdrawalId, status: { in: ["failed", "send_unknown"] } },
    data: { status: "refunded", resolvedAt: new Date(), evidence: evidence as unknown as Prisma.InputJsonValue },
  });
  if (flipped.count !== 1) {
    const w = await tx.withdrawal.findUnique({ where: { id: withdrawalId }, select: { status: true } });
    throw new NotRefundable(withdrawalId, w?.status ?? "missing");
  }
  await tx.reservation.updateMany({ where: { withdrawalId, status: "held" }, data: { status: "released", releasedAt: new Date(), reason: "refunded with on-chain absence evidence" } });
}
