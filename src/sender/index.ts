// The sender: pending → sending → sent | failed | send_unknown, one broadcast
// per decision, never a retry on its own. Real broadcast arrives at step 4
// behind TxSender.
//
// value-model's review finding 1 (2026-09-04): a row put BACK to `pending`
// with nobody to re-submit it would later be EXPIRED by the reconciler —
// a valid request silently restored with no reason the client can act on.
// The pending-submitter now exists (src/worker/index.ts) and closes the
// route's fire-and-forget window; a ChainUnavailable still RELEASES
// the reservation (status cancelled, reason 'chain_unavailable') and tells
// the client with a withdrawal.cancelled webhook; the client retries with a
// new idempotency key. Nothing ever looks sent, and nothing sits pending
// with no owner.
import { prisma } from "@/db/client.js";
import { appendAudit } from "@/audit/append.js";
import { chainAdapters, ChainUnavailable } from "@/chain/registry.js";
import { enqueue } from "@/webhooks/dispatch.js";
import { release } from "@/allowance/index.js";

export async function submitForSending(withdrawalId: string): Promise<"sent" | "failed" | "send_unknown" | "not_pending" | "chain_unavailable"> {
  // claim: pending → sending, exactly once
  const claimed = await prisma.withdrawal.updateMany({ where: { id: withdrawalId, status: "pending" }, data: { status: "sending" } });
  if (claimed.count !== 1) return "not_pending";
  const w = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId }, select: { keyId: true, chain: true, toAddress: true, amount: true } });
  let result;
  try { result = await chainAdapters().sender.send(w.chain, w.toAddress, w.amount.toString()); }
  catch (e) {
    if (e instanceof ChainUnavailable) {
      // nothing was broadcast, nothing is unknown: release, with the reason visible
      await prisma.$transaction(async (tx) => {
        await tx.withdrawal.updateMany({ where: { id: withdrawalId, status: "sending" }, data: { status: "pending" } });
        const res = await tx.reservation.findUniqueOrThrow({ where: { withdrawalId }, select: { id: true } });
        await release(tx, res.id, "chain_unavailable");
        await appendAudit(tx, { keyId: w.keyId, actor: "sender", action: "withdrawal.cancelled", subjectId: withdrawalId, params: { reason: "chain_unavailable", detail: e.message } });
        await enqueue(w.keyId, "withdrawal.cancelled", `wd_${withdrawalId}_cancelled`, { withdrawal_id: withdrawalId, reason: "chain_unavailable", amount: w.amount.toString(), chain: w.chain, retry: "with a new Idempotency-Key" });
      });
      return "chain_unavailable";
    }
    // a throw AFTER a broadcast may have happened is the one state that must never be optimistic
    await prisma.$transaction(async (tx) => {
      await tx.withdrawal.updateMany({ where: { id: withdrawalId, status: "sending" }, data: { status: "send_unknown" } });
      await appendAudit(tx, { keyId: w.keyId, actor: "sender", action: "withdrawal.send_unknown", subjectId: withdrawalId, params: { error: e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 300) : String(e) } });
    });
    return "send_unknown";
  }
  if (result.ok) {
    await prisma.$transaction(async (tx) => {
      await tx.withdrawal.updateMany({ where: { id: withdrawalId, status: "sending" }, data: { status: "sent", txHash: result.txHash, sentAt: new Date() } });
      await appendAudit(tx, { keyId: w.keyId, actor: "sender", action: "withdrawal.sent", subjectId: withdrawalId, params: { txHash: result.txHash } });
      await enqueue(w.keyId, "withdrawal.sent", `wd_${withdrawalId}_sent`, { withdrawal_id: withdrawalId, tx_hash: result.txHash, amount: w.amount.toString(), chain: w.chain });
    });
    return "sent";
  }
  if (result.reason === "unknown") {
    // the adapter may have broadcast: keep the CANDIDATE hash on the row so the
    // reconciler can prove absence before anything is restored
    await prisma.$transaction(async (tx) => {
      await tx.withdrawal.updateMany({ where: { id: withdrawalId, status: "sending" }, data: { status: "send_unknown", txHash: result.candidateTxHash } });
      await appendAudit(tx, { keyId: w.keyId, actor: "sender", action: "withdrawal.send_unknown", subjectId: withdrawalId, params: { candidateTxHash: result.candidateTxHash, detail: result.detail.slice(0, 300) } });
    });
    return "send_unknown";
  }
  await prisma.$transaction(async (tx) => {
    // PRE-BROADCAST refusal by construction (no signed tx exists): `failed`, which
    // keeps CONSUMING until markRefunded — the one case an empty txHashesChecked is evidence
    await tx.withdrawal.updateMany({ where: { id: withdrawalId, status: "sending" }, data: { status: "failed", resolvedAt: new Date() } });
    await appendAudit(tx, { keyId: w.keyId, actor: "sender", action: "withdrawal.failed", subjectId: withdrawalId, params: { reason: result.reason, preBroadcast: true, detail: result.detail.slice(0, 300) } });
    await enqueue(w.keyId, "withdrawal.failed", `wd_${withdrawalId}_failed`, { withdrawal_id: withdrawalId, reason: result.reason, amount: w.amount.toString(), chain: w.chain });
  });
  return "failed";
}
