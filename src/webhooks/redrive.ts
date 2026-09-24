// REDRIVE — contract v1.1 A5/A11.6: the named recovery for a store that missed
// a notification. An EXHAUSTED delivery is put back on the schedule (pending,
// attempts 0, due now); the worker then sends it like any other, to the
// client's CURRENT key (A6), and the store credits through its normal path.
//
// Idempotent by construction: the update is conditional on status
// `exhausted`, so a second run finds nothing to change. `delivered` and
// `failed` (suppressed by rule) rows are never touched. Nothing here moves
// money; a redriven event is a notification the store must re-fetch anyway.
import { z } from "zod";
import { prisma } from "@/db/client.js";
import { appendAudit } from "@/audit/append.js";
import { logger } from "@/log.js";

const log = logger.child({ module: "webhooks.redrive" });

export const RedriveInput = z.object({
  since: z.date(),
  apply: z.boolean(),
  actor: z.string().min(1).max(100),
  eventType: z.string().min(1).max(64).optional(),
}).strict();
export type RedriveInput = z.infer<typeof RedriveInput>;

export interface RedriveResult { apply: boolean; candidates: string[]; requeued: number }

/** Exhausted deliveries created at or after `since` (optionally of one type); re-queued only with apply. */
export async function redriveDeliveries(raw: RedriveInput): Promise<RedriveResult> {
  const input = RedriveInput.parse(raw);
  const where = { status: "exhausted" as const, createdAt: { gte: input.since }, ...(input.eventType ? { eventType: input.eventType } : {}) };
  const rows = await prisma.webhookDelivery.findMany({ where, orderBy: { createdAt: "asc" }, select: { id: true, keyId: true, eventId: true, eventType: true, attempts: true, lastError: true } });
  const candidates = rows.map((r) => r.id);
  if (!input.apply) {
    log.info({ actor: input.actor, action: "webhook.redrive", result: "dry_run", candidates: candidates.length }, "dry run");
    return { apply: false, candidates, requeued: 0 };
  }
  let requeued = 0;
  for (const r of rows) {
    await prisma.$transaction(async (tx) => {
      const flipped = await tx.webhookDelivery.updateMany({ where: { id: r.id, status: "exhausted" }, data: { status: "pending", attempts: 0, nextAttemptAt: new Date(), lastError: `redriven by ${input.actor} after ${r.attempts} attempts: ${r.lastError ?? ""}`.slice(0, 500) } });
      if (flipped.count !== 1) return; // someone else redrove it first
      requeued++;
      await appendAudit(tx, { keyId: r.keyId, actor: `ops:${input.actor}`, action: "webhook.redriven", subjectId: r.id, params: { eventId: r.eventId, eventType: r.eventType, previousAttempts: r.attempts } });
    });
  }
  log.info({ actor: input.actor, action: "webhook.redrive", result: "applied", candidates: candidates.length, requeued }, "redrive applied");
  return { apply: true, candidates, requeued };
}
