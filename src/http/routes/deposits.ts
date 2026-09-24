// GET /v1/deposits (+ /:id) — the "+" side, read-only. Contract §4/§5: Deposit
// objects in a {object:"list"} envelope, owned by the CLIENT (any of its keys,
// v1.1 A6 — reachable after a rotation), 404 for unknown and foreign ids alike.
// An intent's address carries reference "payment_intent:<pi>" (G2), so a
// deposit to it reports the INTENT's reference, the store's own id.
// Only `confirmed` rows count toward an allowance; `detected` is shown so a
// client can see money on its way, labelled as such.
import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "@/db/client.js";
import { bearerAuth, scope } from "../auth.js";
import { ApiError, fieldsOf } from "../errors.js";

// ── /v1 ──
const DEPOSIT_SELECT = {
  id: true, chain: true, txHash: true, amount: true, confirmations: true, status: true, detectedAt: true, creditedAt: true,
  address: { select: { reference: true, address: true, intent: { select: { id: true, reference: true } } } },
} as const;
type DepositRow = NonNullable<Awaited<ReturnType<typeof readDeposit>>>;
function readDeposit(clientId: string, id: string) {
  return prisma.deposit.findFirst({ where: { id, key: { clientId } }, select: DEPOSIT_SELECT });
}

export function renderDeposit(d: DepositRow): Record<string, unknown> {
  return {
    id: d.id, object: "deposit", status: d.status, chain: d.chain, tx_hash: d.txHash, amount: d.amount.toFixed(),
    confirmations: d.confirmations, address: d.address.address, reference: d.address.intent?.reference ?? d.address.reference,
    payment_intent_id: d.address.intent?.id ?? null,
    detected_at: d.detectedAt.toISOString(), confirmed_at: d.creditedAt?.toISOString() ?? null,
  };
}

const ListQuery = z.object({
  reference: z.string().min(1).max(200).optional(),
  payment_intent_id: z.string().min(1).max(64).optional(),
  since: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

export const deposits = new Hono();
deposits.use("*", bearerAuth);

deposits.get("/", scope("deposits.read"), async (c) => {
  const clientId = c.get("key").clientId;
  const q = ListQuery.safeParse(c.req.query());
  if (!q.success) throw new ApiError("validation_failed", "Query must be ?reference=&payment_intent_id=&since=<ISO-8601>&limit=1..100.", { fields: fieldsOf(q.error.issues) });
  const { reference, payment_intent_id, since, limit } = q.data;
  const rows = await prisma.deposit.findMany({
    where: {
      key: { clientId },
      ...(since ? { detectedAt: { gte: new Date(since) } } : {}),
      // `reference` matches what the Deposit object reports: the address's own
      // reference, or — for an intent address — the intent's.
      ...(reference || payment_intent_id ? { address: { ...(reference ? { OR: [{ reference }, { intent: { reference } }] } : {}), ...(payment_intent_id ? { intent: { id: payment_intent_id } } : {}) } } : {}),
    },
    orderBy: [{ detectedAt: "asc" }, { id: "asc" }], take: limit + 1, select: DEPOSIT_SELECT,
  });
  return c.json({ object: "list", data: rows.slice(0, limit).map(renderDeposit), has_more: rows.length > limit }, 200);
});

deposits.get("/:id", scope("deposits.read"), async (c) => {
  const row = await readDeposit(c.get("key").clientId, c.req.param("id"));
  if (!row) throw new ApiError("not_found", "No such deposit.");
  return c.json(renderDeposit(row), 200);
});
