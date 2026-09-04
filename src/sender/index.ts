// The sender: pending → sending → sent | failed | send_unknown, one broadcast
// per decision, never a retry on its own. Real broadcast arrives at step 4
// behind TxSender; until then every submit records `send_unknown`? NO — it
// must not touch money state it cannot prove. It leaves the row `pending`
// and records the refusal in the audit trail, so nothing looks sent.
import { prisma } from "@/db/client.js";
import { appendAudit } from "@/audit/append.js";
import { chainAdapters, ChainUnavailable } from "@/chain/registry.js";
import { enqueue } from "@/webhooks/dispatch.js";

export async function submitForSending(withdrawalId: string): Promise<"sent" | "failed" | "send_unknown" | "not_pending" | "chain_unavailable"> {
  // claim: pending → sending, exactly once
  const claimed = await prisma.withdrawal.updateMany({ where: { id: withdrawalId, status: "pending" }, data: { status: "sending" } });
  if (claimed.count !== 1) return "not_pending";
  const w = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId }, select: { keyId: true, chain: true, toAddress: true, amount: true } });
  let result;
  try { result = await chainAdapters().sender.send(w.chain, w.toAddress, w.amount.toString()); }
  catch (e) {
    if (e instanceof ChainUnavailable) {
      // put it back: nothing was broadcast, nothing is unknown
      await prisma.$transaction(async (tx) => {
        await tx.withdrawal.updateMany({ where: { id: withdrawalId, status: "sending" }, data: { status: "pending" } });
        await appendAudit(tx, { keyId: w.keyId, actor: "sender", action: "withdrawal.send_refused", subjectId: withdrawalId, params: { reason: e.message } });
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
  await prisma.$transaction(async (tx) => {
    // failed keeps CONSUMING until markRefunded with on-chain-absence evidence (value-model's clause)
    await tx.withdrawal.updateMany({ where: { id: withdrawalId, status: "sending" }, data: { status: "failed", resolvedAt: new Date() } });
    await appendAudit(tx, { keyId: w.keyId, actor: "sender", action: "withdrawal.failed", subjectId: withdrawalId, params: { reason: result.reason, detail: result.detail.slice(0, 300) } });
    await enqueue(w.keyId, "withdrawal.failed", `wd_${withdrawalId}_failed`, { withdrawal_id: withdrawalId, reason: result.reason, amount: w.amount.toString(), chain: w.chain });
  });
  return "failed";
}
