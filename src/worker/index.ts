// THE WORKER — two loops, one process, separate from the API (its own PM2
// entry in ecosystem.config.cjs, NOT registered until his keystroke).
//
// 1. PENDING SUBMITTER. Every `pending` withdrawal older than GRACE_MS is
//    handed to the sender. This closes the fire-and-forget window in the
//    route (a crash between commit and submit) and the ChainUnavailable
//    case: nothing sits pending with no owner. A row still pending after
//    GIVE_UP_MS — i.e. the worker itself has been failing to submit it for
//    that long — is EXPIRED through allowance.expire(), audited one row per
//    id (actor 'reconciler'), and the client told with withdrawal.cancelled
//    reason 'expired'. value-model's clause: expire() only ever touches rows
//    the worker has given up on.
// 2. WEBHOOK DELIVERER. Every delivery whose next_attempt_at has passed gets
//    one attempt; the schedule in dispatch.ts decides the next.
//
// The reconciler (send_unknown / failed → refunded with on-chain-absence
// evidence) is a SEPARATE file, reviewed by value-model before it merges.
import pino from "pino";
import { prisma } from "@/db/client.js";
import { appendAudit } from "@/audit/append.js";
import { expire } from "@/allowance/index.js";
import { submitForSending } from "@/sender/index.js";
import { attemptDelivery, enqueue } from "@/webhooks/dispatch.js";
import { chainAdapters } from "@/chain/registry.js";
import { reconcileOnce } from "./reconciler.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info", name: "samapay-worker" });
export const GRACE_MS = 5_000;                 // a route's own submit gets this long first
export const GIVE_UP_MS = 30 * 60_000;         // 30 min of failing to submit = expire, visibly
export const TICK_MS = 5_000;
const BATCH = 50;

export async function submitPendingOnce(now = new Date()): Promise<{ submitted: number; expired: number }> {
  const stale = new Date(now.getTime() - GRACE_MS);
  const rows = await prisma.withdrawal.findMany({ where: { status: "pending", requestedAt: { lt: stale } }, orderBy: { requestedAt: "asc" }, take: BATCH, select: { id: true } });
  let submitted = 0;
  for (const r of rows) { const out = await submitForSending(r.id); if (out !== "not_pending") submitted++; }
  // give up on what is STILL pending after the window — only rows the worker kept failing on
  const giveUp = new Date(now.getTime() - GIVE_UP_MS);
  const expired = await prisma.$transaction(async (tx) => {
    const { withdrawalIds } = await expire(tx, giveUp);
    for (const id of withdrawalIds) {
      const w = await tx.withdrawal.findUniqueOrThrow({ where: { id }, select: { keyId: true, amount: true, chain: true } });
      await appendAudit(tx, { keyId: w.keyId, actor: "reconciler", action: "withdrawal.expired", subjectId: id, params: { giveUpAfterMs: GIVE_UP_MS } });
      await enqueue(w.keyId, "withdrawal.cancelled", `wd_${id}_expired`, { withdrawal_id: id, reason: "expired", amount: w.amount.toString(), chain: w.chain, retry: "with a new Idempotency-Key" });
    }
    return withdrawalIds.length;
  });
  return { submitted, expired };
}

export async function deliverDueOnce(now = new Date()): Promise<{ attempted: number; delivered: number }> {
  const due = await prisma.webhookDelivery.findMany({ where: { status: "pending", nextAttemptAt: { lte: now } }, orderBy: { nextAttemptAt: "asc" }, take: BATCH, select: { id: true } });
  let delivered = 0;
  for (const d of due) { const r = await attemptDelivery(d.id); if (r.outcome === "delivered") delivered++; }
  return { attempted: due.length, delivered };
}

/** 3. CONFIRM OUTGOING — send_unknown with a hash that the chain now knows → sent. Confirm only; restore lives in reconciler.ts. */
export async function confirmOutgoingOnce(): Promise<{ confirmed: number }> {
  const rows = await prisma.withdrawal.findMany({ where: { status: "send_unknown", txHash: { not: null } }, take: BATCH, select: { id: true, keyId: true, chain: true, txHash: true, amount: true } });
  let confirmed = 0;
  for (const w of rows) {
    const r = await chainAdapters().prover.exists(w.chain, w.txHash as string);
    if (!r.known || !r.confirmed) continue;
    await prisma.$transaction(async (tx) => {
      const flipped = await tx.withdrawal.updateMany({ where: { id: w.id, status: "send_unknown" }, data: { status: "sent", sentAt: new Date() } });
      if (flipped.count !== 1) return;
      confirmed++;
      await appendAudit(tx, { keyId: w.keyId, actor: "reconciler", action: "withdrawal.sent", subjectId: w.id, params: { txHash: w.txHash, confirmations: r.confirmations, node: r.node, via: "confirmOutgoingOnce" } });
      await enqueue(w.keyId, "withdrawal.sent", `wd_${w.id}_sent`, { withdrawal_id: w.id, tx_hash: w.txHash, amount: w.amount.toString(), chain: w.chain });
    });
  }
  return { confirmed };
}

async function loop(): Promise<never> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const a = await submitPendingOnce();
      const b = await deliverDueOnce();
      const c = await confirmOutgoingOnce();
      const d = await reconcileOnce();
      if (a.submitted || a.expired || b.attempted || c.confirmed || d.refunded || d.present_on_chain) log.info({ ...a, ...b, ...c, reconcile: d }, "tick");
    } catch (e) { log.error({ err: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }, "tick failed"); }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}
if (process.argv[1]?.endsWith("worker/index.ts") || process.argv[1]?.endsWith("worker/index.js")) void loop();
