// GET /v1/deposits (+ /:id) — the "+" side, read-only. Contract §4/§5: Deposit
// objects in a {object:"list"} envelope, owned by the CLIENT (any of its keys,
// v1.1 A6 — reachable after a rotation), 404 for unknown and foreign ids alike.
// Only `confirmed` rows count toward an allowance; `detected` is shown so a
// client can see money on its way, labelled as such.
import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "@/db/client.js";
import { bearerAuth, scope } from "../auth.js";
import { ApiError, fieldsOf } from "../errors.js";
import { DEPOSIT_RENDER_SELECT, parseDepositId, renderDeposit } from "@/render/deposit.js";

// Rendering is src/render/deposit.ts — the SAME function the deposit.confirmed
// snapshot uses. Ids on the wire are "dep_<row id>"; only that form is accepted.
function readDeposit(clientId: string, publicId: string) {
  const id = parseDepositId(publicId);
  if (!id) return Promise.resolve(null);
  return prisma.deposit.findFirst({ where: { id, key: { clientId } }, select: DEPOSIT_RENDER_SELECT });
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
    orderBy: [{ detectedAt: "asc" }, { id: "asc" }], take: limit + 1, select: DEPOSIT_RENDER_SELECT,
  });
  return c.json({ object: "list", data: rows.slice(0, limit).map(renderDeposit), has_more: rows.length > limit }, 200);
});

deposits.get("/:id", scope("deposits.read"), async (c) => {
  const row = await readDeposit(c.get("key").clientId, c.req.param("id"));
  if (!row) throw new ApiError("not_found", "No such deposit.");
  return c.json(renderDeposit(row), 200);
});
