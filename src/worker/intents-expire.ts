// THE EXPIRY SWEEP — an intent whose expires_at has passed with no deposit at
// its address never gets an observer tick of its own, so something has to
// ask the state machine about it. This does, once per unpaid intent past its
// expiry, and persists the answer through the same advanceIntent() the
// observer uses: `expired` (nothing), `expired_partial` (something confirmed),
// or — an in-time payment still confirming — left `processing`. One
// payment_intent.expired per intent, by the same two guards as every other
// transition (src/intents/advance.ts).
//
// To be called from the worker loop (src/worker/index.ts, not owned by the
// intents engine) once per tick: expireIntentsOnce().
import type { Chain } from "@prisma/client";
import { prisma } from "@/db/client.js";
import logger from "@/log.js";
import { advanceIntent } from "@/intents/advance.js";

const log = logger.child({ mod: "worker/intents-expire" });
const BATCH = 200;
// ROUND-ROBIN by id, like src/intents/sweep.ts: a `processing` intent past
// expiry whose in-time deposit never confirms stays due for ever, and "the
// oldest 200" would let such intents starve every newer one (Q's review M1).
let pageAfter: string | null = null;

export async function expireIntentsOnce(opts: { now?: Date; confirmationsRequired: (chain: Chain) => number }): Promise<{ checked: number; expired: number }> {
  const now = opts.now ?? new Date();
  const due = await prisma.paymentIntent.findMany({
    where: { status: { in: ["requires_payment", "processing"] }, expiresAt: { lt: now }, ...(pageAfter ? { id: { gt: pageAfter } } : {}) },
    orderBy: { id: "asc" }, take: BATCH, select: { id: true, chain: true },
  });
  const last = due[due.length - 1];
  pageAfter = due.length === BATCH && last ? last.id : null;
  let expired = 0;
  for (const d of due) {
    try {
      const r = await advanceIntent(d.id, { now, confirmationsRequired: opts.confirmationsRequired(d.chain), actor: "expiry" });
      if (r.outcome === "advanced" && (r.to === "expired" || r.to === "expired_partial")) expired++;
    } catch (e) {
      log.error({ actor: "expiry", action: "payment_intent.expire", result: "failed", intentId: d.id, err: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }, "expire failed; retried next tick");
    }
  }
  if (due.length) log.info({ actor: "expiry", action: "payment_intent.expire_sweep", result: "done", checked: due.length, expired }, "expiry sweep");
  return { checked: due.length, expired };
}
