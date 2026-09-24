// advanceIntent() — persist what src/intents/state.ts decides, and emit the
// event the transition calls for, in ONE transaction.
//
// EXACTLY ONE EVENT PER (intent, type), EVEN UNDER CONCURRENT TICKS. Two
// guards, each on its own:
//  1. The status flip is `UPDATE … WHERE id = ? AND status = <the status we
//     read>`. Two ticks that both read `processing` and both decide
//     `succeeded` serialise on the row lock; the second one's WHERE no longer
//     matches, it updates 0 rows, and it emits NOTHING. Only the tick that
//     actually moved the row calls enqueueEvent.
//  2. The events table's UNIQUE(object_id, type) behind enqueueEvent (G3),
//     so even a caller that got (1) wrong cannot write a second event row.
//
// The deposits are read in the same transaction; amount_received is never
// stored, so there is nothing here to keep in sync.
import { prisma } from "@/db/client.js";
import { appendAudit } from "@/audit/append.js";
import logger from "@/log.js";
import { computeIntentState, eventForTransition, type IntentStatus } from "./state.js";
import { eventSink } from "./events-port.js";
import { intentDeposits, loadIntentRow, renderPaymentIntent } from "./render.js";

const log = logger.child({ mod: "intents/advance" });

export type AdvanceOutcome =
  | { outcome: "unchanged"; status: IntentStatus }
  | { outcome: "advanced"; from: IntentStatus; to: IntentStatus; event: string | null }
  | { outcome: "lost_race" }
  | { outcome: "not_found" };

const SUCCEEDED: ReadonlySet<IntentStatus> = new Set(["succeeded", "succeeded_late"]);
const EXPIRED: ReadonlySet<IntentStatus> = new Set(["expired", "expired_partial"]);

export async function advanceIntent(intentId: string, opts: { now: Date; confirmationsRequired: number; actor: "observer" | "expiry" }): Promise<AdvanceOutcome> {
  const { now, confirmationsRequired, actor } = opts;
  return prisma.$transaction(async (tx) => {
    const row = await loadIntentRow(tx, intentId);
    if (!row) return { outcome: "not_found" as const };
    const prev = row.status;
    const next = computeIntentState({ amount: row.amount, expiresAt: row.expiresAt, current: prev, deposits: intentDeposits(row), now });
    if (next.status === prev) return { outcome: "unchanged" as const, status: prev };

    const data: { status: IntentStatus; succeededAt?: Date; expiredAt?: Date } = { status: next.status };
    if (SUCCEEDED.has(next.status)) data.succeededAt = now;
    // An expired → succeeded_late intent KEEPS its expired_at: it did expire.
    if (EXPIRED.has(next.status) && !EXPIRED.has(prev)) data.expiredAt = now;
    const flipped = await tx.paymentIntent.updateMany({ where: { id: intentId, status: prev }, data });
    if (flipped.count !== 1) return { outcome: "lost_race" as const }; // another tick moved it; it emitted, we do not

    const event = eventForTransition(prev, next.status);
    await appendAudit(tx, {
      keyId: row.keyId, actor, action: `payment_intent.${next.status}`, subjectId: intentId,
      params: { from: prev, to: next.status, amountReceived: next.amountReceived.toFixed(), paidAt: next.paidAt?.toISOString() ?? null, txHashes: next.txHashes, event },
    });
    if (event) {
      const after = await loadIntentRow(tx, intentId);
      if (!after) throw new Error(`intent ${intentId} vanished inside its own transaction`);
      await eventSink()(tx, { type: event, objectKind: "payment_intent", objectId: intentId, snapshot: { ...renderPaymentIntent(after, confirmationsRequired, now) } });
    }
    log.info({ actor, action: "payment_intent.advance", result: "advanced", intentId, from: prev, to: next.status, event }, "payment intent advanced");
    return { outcome: "advanced" as const, from: prev, to: next.status, event };
  });
}
