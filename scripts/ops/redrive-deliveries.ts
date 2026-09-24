// CONTRACT v1.1 A5 — re-send webhook deliveries that EXHAUSTED their retry
// schedule (the store was down > ~45 h, or answered non-2xx throughout).
//
//   DRY RUN (default, writes nothing — lists what would be re-queued):
//     pnpm exec tsx --env-file=.env scripts/ops/redrive-deliveries.ts --since=2026-09-25T00:00:00Z
//   APPLY:
//     … --since=<ISO> --apply --by=ibrahim [--event-type=deposit.confirmed]
//
// Re-queued rows go back to `pending`, attempts 0, due now; the worker sends
// them to the client's CURRENT key. Idempotent: only `exhausted` rows change,
// so a second run re-queues nothing. No backup gate: nothing here moves money
// or deletes anything — each re-queue is one conditional update plus one
// audit row (actor ops:<by>, action webhook.redriven). The logic lives in
// src/webhooks/redrive.ts; this file only parses arguments and prints.
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { redriveDeliveries } from "@/webhooks/redrive.js";
import { prisma } from "@/db/client.js";

const Args = z.object({
  since: z.iso.datetime({ offset: true }),
  apply: z.boolean(),
  by: z.string().regex(/^[a-z][a-z0-9_-]{1,40}$/).optional(),
  eventType: z.enum(["deposit.confirmed", "payment_intent.succeeded", "payment_intent.expired", "withdrawal.sent", "withdrawal.failed", "withdrawal.cancelled", "withdrawal.refunded"]).optional(),
}).strict();
export type RedriveArgs = z.infer<typeof Args>;

export function parseArgs(argv: readonly string[]): RedriveArgs {
  const raw: Record<string, unknown> = { apply: false };
  for (const a of argv) {
    if (a === "--apply") { raw.apply = true; continue; }
    const m = /^--(since|by|event-type)=(.*)$/.exec(a);
    if (m) { raw[m[1] === "event-type" ? "eventType" : (m[1] as string)] = m[2]; continue; }
    throw new Error(`unknown argument ${a} (use --since=<ISO> [--apply --by=<who>] [--event-type=…])`);
  }
  const parsed = Args.safeParse(raw);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `--${i.path.join(".")}: ${i.message}`).join("; "));
  if (parsed.data.apply && !parsed.data.by) throw new Error("--apply needs --by=<who>");
  return parsed.data;
}

async function main() {
  let args: RedriveArgs;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(`REFUSED: ${(e as Error).message}`); process.exit(2); }
  const out = await redriveDeliveries({ since: new Date(args.since), apply: args.apply, actor: args.by ?? "dry-run", ...(args.eventType ? { eventType: args.eventType } : {}) });
  console.log(args.apply ? `APPLIED: re-queued ${out.requeued} of ${out.candidates.length} exhausted deliveries since ${args.since}` : `DRY RUN: ${out.candidates.length} exhausted deliveries since ${args.since} would be re-queued (add --apply --by=<who>)`);
  for (const id of out.candidates) console.log(`  ${id}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(() => prisma.$disconnect()).catch(async (e) => { console.error("redrive-deliveries crashed:", e); await prisma.$disconnect(); process.exit(1); });
}
