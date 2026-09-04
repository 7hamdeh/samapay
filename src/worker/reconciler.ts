// THE RECONCILER — the only caller of allowance.markRefunded. Turns a
// `failed` or `send_unknown` withdrawal into `refunded` (restoring the
// allowance) ONLY behind value-model's evidence gate:
//
//   1. every candidate tx hash for the row is checked, on at least TWO
//      independent endpoints, and ALL say absent               (nodesAsked >= 2)
//   2. at least MIN_AGE_MS have passed since sentAt ?? requestedAt (a signed
//      tx can sit in a mempool; absence-now is not absence-forever)
//   3. a `failed` row with NO candidate hash is refundable only if its audit
//      says preBroadcast:true; otherwise it is treated as send_unknown and
//      needs a hash — which it cannot have, so it stays consuming until an
//      operator supplies evidence by hand (his line). Never guessed.
//
// This file does not merge until value-model has checked the evidence
// object it builds against markRefunded's required fields.
import pino from "pino";
import { prisma } from "@/db/client.js";
import { appendAudit } from "@/audit/append.js";
import { markRefunded, type AbsenceEvidence } from "@/allowance/index.js";
import { chainAdapters } from "@/chain/registry.js";
import { enqueue } from "@/webhooks/dispatch.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info", name: "samapay-reconciler" });
export const MIN_AGE_MS = 10 * 60_000;
export const MIN_NODES = 2;

export type ReconcileOutcome = "refunded" | "too_young" | "present_on_chain" | "insufficient_nodes" | "needs_hash" | "not_eligible";

export async function reconcileOne(withdrawalId: string, now = new Date()): Promise<ReconcileOutcome> {
  const w = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId }, select: { keyId: true, chain: true, status: true, txHash: true, sentAt: true, requestedAt: true, amount: true } });
  if (w.status !== "failed" && w.status !== "send_unknown") return "not_eligible";
  const since = w.sentAt ?? w.requestedAt;
  if (now.getTime() - since.getTime() < MIN_AGE_MS) return "too_young";

  // candidate hashes: the row's own, plus any the audit trail recorded for it
  const audits = await prisma.auditEvent.findMany({ where: { subjectId: withdrawalId, action: { in: ["withdrawal.send_unknown", "withdrawal.failed", "withdrawal.sent"] } }, select: { action: true, params: true } });
  const candidates = new Set<string>();
  if (w.txHash) candidates.add(w.txHash);
  let preBroadcast = false;
  for (const a of audits) {
    const p = (a.params ?? {}) as { candidateTxHash?: string | null; txHash?: string | null; preBroadcast?: boolean };
    if (p.candidateTxHash) candidates.add(p.candidateTxHash);
    if (p.txHash) candidates.add(p.txHash);
    if (a.action === "withdrawal.failed" && p.preBroadcast === true) preBroadcast = true;
  }
  if (candidates.size === 0 && !(w.status === "failed" && preBroadcast)) return "needs_hash";

  // prove absence for every candidate, on >= MIN_NODES endpoints
  let nodesAskedMin = Number.POSITIVE_INFINITY;
  for (const h of candidates) {
    const r = await chainAdapters().prover.exists(w.chain, h);
    if (r.known) return "present_on_chain"; // it happened: not refundable, ever — the observer/sender path owns it now
    nodesAskedMin = Math.min(nodesAskedMin, r.nodesAsked);
  }
  if (candidates.size > 0 && nodesAskedMin < MIN_NODES) return "insufficient_nodes";

  const evidence: AbsenceEvidence = {
    checkedVia: candidates.size === 0 ? "pre-broadcast failure by construction (no signed tx)" : `tx existence on ${nodesAskedMin} independent endpoints`,
    txHashesChecked: [...candidates],
    checkedAt: now.toISOString(),
    absentOnChain: true,
  };
  await prisma.$transaction(async (tx) => {
    await markRefunded(tx, withdrawalId, evidence);
    await appendAudit(tx, { keyId: w.keyId, actor: "reconciler", action: "withdrawal.refunded", subjectId: withdrawalId, params: { ...evidence, ageMs: now.getTime() - since.getTime() } });
    await enqueue(w.keyId, "withdrawal.cancelled", `wd_${withdrawalId}_refunded`, { withdrawal_id: withdrawalId, reason: "refunded", amount: w.amount.toString(), chain: w.chain, evidence: { checked_via: evidence.checkedVia, tx_hashes_checked: evidence.txHashesChecked } });
  });
  return "refunded";
}

export async function reconcileOnce(now = new Date()): Promise<Record<ReconcileOutcome, number>> {
  const tally: Record<ReconcileOutcome, number> = { refunded: 0, too_young: 0, present_on_chain: 0, insufficient_nodes: 0, needs_hash: 0, not_eligible: 0 };
  const rows = await prisma.withdrawal.findMany({ where: { status: { in: ["failed", "send_unknown"] } }, orderBy: { requestedAt: "asc" }, take: 50, select: { id: true } });
  for (const r of rows) {
    try { tally[await reconcileOne(r.id, now)]++; }
    catch (e) { log.error({ withdrawalId: r.id, err: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }, "reconcile failed"); }
  }
  return tally;
}
