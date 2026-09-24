// The observer's hook: after a tick has recorded and confirmed deposits,
// re-decide every intent on the chain that is not yet paid and has anything
// at its address. Reading the whole open set (rather than "intents touched
// this tick") means a crash between confirming a deposit and advancing its
// intent is repaired by the next tick, with no bookkeeping of what was missed.
// Expired intents stay in the set: a late payment must still complete them
// (expired → succeeded_late; money is never lost).
import type { Chain } from "@prisma/client";
import { prisma } from "@/db/client.js";
import logger from "@/log.js";
import { advanceIntent } from "./advance.js";

const log = logger.child({ mod: "intents/sweep" });

const BATCH = 200;
// ⚠️ ROUND-ROBIN, NOT "THE OLDEST 200". expired_partial intents stay in this
// set for ever (a late payment must still complete them), so a fixed "oldest
// first" page fills up with abandoned ones and every newer intent is never
// looked at again (Q's review M1). Each tick takes the next page by id and
// wraps; every open intent is re-decided within ceil(open / BATCH) ticks.
const pageAfter = new Map<Chain, string>();

export async function advanceIntentsForChain(chain: Chain, opts: { now: Date; confirmationsRequired: number }): Promise<{ checked: number; advanced: number }> {
  const open = await prisma.paymentIntent.findMany({
    where: {
      chain,
      status: { in: ["requires_payment", "processing", "expired", "expired_partial"] },
      address: { watchDisabledAt: null, deposits: { some: { status: { not: "orphaned" }, amount: { gt: 0 } } } },
      ...(pageAfter.has(chain) ? { id: { gt: pageAfter.get(chain) as string } } : {}),
    },
    orderBy: { id: "asc" }, take: BATCH, select: { id: true },
  });
  const last = open[open.length - 1];
  if (open.length === BATCH && last) pageAfter.set(chain, last.id); else pageAfter.delete(chain);
  let advanced = 0;
  for (const { id } of open) {
    // One intent that cannot advance (its transaction rolled back) must not
    // stall the others; it stays where it was and the next tick retries it.
    try {
      const r = await advanceIntent(id, { ...opts, actor: "observer" });
      if (r.outcome === "advanced") advanced++;
    } catch (e) {
      log.error({ actor: "observer", action: "payment_intent.advance", result: "failed", intentId: id, err: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }, "advance failed; retried next tick");
    }
  }
  return { checked: open.length, advanced };
}
