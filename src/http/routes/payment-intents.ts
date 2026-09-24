// /v1/payment-intents — contract §4 (object) and §5 (endpoints).
//   POST /        payment_intents.write  {amount, chain, reference, expires_in_sec?} → 201
//   GET  /:id     payment_intents.read   → 200, or 404 for an unknown id AND for
//                                          another client's id (no existence oracle)
//   GET  /        payment_intents.read   ?reference=&status=&limit≤100&starting_after=
// The merchant is ALWAYS the key's client, never a body field. Creation is
// G2's createIntent() (src/intents); this file validates, maps its errors to
// the §6 table and renders the object. The rendered object is always READ
// BACK from the database, so POST and GET can never render differently.
import { Hono } from "hono";
import { z } from "zod";
import { Prisma, type Chain, type PaymentIntentStatus } from "@prisma/client";
import { prisma } from "@/db/client.js";
import { logger } from "@/log.js";
import { getChainConfig } from "@/chain/impl/config.js";
import { INTENT_SELECT, renderPaymentIntent, type IntentRow } from "@/intents/index.js";
import { bearerAuth, scope } from "../auth.js";
import { ApiError, fieldsOf } from "../errors.js";
import { idempotent } from "../idempotency.js";

// ── PORT: G2's createIntent. The COMPOSITION ROOT (src/server.ts bootApi)
// installs it; the server refuses to start while it is unwired
// (assertApiPortsWired). Unwired, a request is a 500 internal that logs why —
// never a 503 that would read as a normal derivation outage.
export interface CreateIntentInput { amount: string; chain: Chain; reference: string; expiresInSec: number }
export type CreateIntentFn = (clientId: string, keyId: string, input: CreateIntentInput) => Promise<{ id: string }>;
let createIntentImpl: CreateIntentFn | null = null;
/** Wiring point: src/server.ts installs G2's createIntent; the verify script installs a fake. */
export function setCreateIntent(fn: CreateIntentFn): void { createIntentImpl = fn; }
export function createIntentWired(): boolean { return createIntentImpl !== null; }

// ── Validation (§5 amount rules, §4 reference) ──
// Order matters: a missing/ill-typed field is 400 validation_failed; a
// present, string-typed but unacceptable value is the specific 422.
export const AMOUNT = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/;
export const REFERENCE = /^[A-Za-z0-9:_-]{1,200}$/;
const CHAINS = ["TRC20", "BEP20"] as const;
const Body = z.object({
  amount: z.string(),
  chain: z.string(),
  reference: z.string(),
  expires_in_sec: z.number().int().min(300).max(604800).optional(),
}).strict();

const STATUSES: readonly PaymentIntentStatus[] = ["requires_payment", "processing", "succeeded", "succeeded_late", "expired", "expired_partial"];
const ListQuery = z.object({
  reference: z.string().max(200).optional(),
  status: z.enum(STATUSES as [PaymentIntentStatus, ...PaymentIntentStatus[]]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  starting_after: z.string().min(1).max(64).optional(),
});

// ── Rendering: G2's renderPaymentIntent — the SAME function the event snapshots use ──
function readIntent(clientId: string, id: string) {
  return prisma.paymentIntent.findFirst({ where: { id, clientId }, select: INTENT_SELECT });
}

function confirmationsRequired(chain: Chain): number {
  try { return getChainConfig(chain).confirmationsRequired; }
  catch { throw new ApiError("chain_unavailable", `The ${chain} chain configuration is unavailable.`); }
}

function renderIntent(row: IntentRow) { return renderPaymentIntent(row, confirmationsRequired(row.chain)); }

async function existingForReference(clientId: string, reference: string, amount: string, chain: Chain): Promise<IntentRow | null> {
  const row = await prisma.paymentIntent.findFirst({ where: { clientId, reference }, select: INTENT_SELECT });
  if (!row) return null;
  if (row.chain !== chain || !row.amount.eq(amount)) {
    throw new ApiError("reference_conflict", "A payment intent with this reference already exists with a different amount or chain.", { payment_intent_id: row.id });
  }
  return row;
}

/** Map G2's typed failures to §6. Anything else propagates to onError → 500 internal. */
function mapCreateError(e: unknown): never {
  const name = e instanceof Error ? e.name : "";
  if (name === "IntentInputInvalid") {
    const fields = (e as { fields?: unknown }).fields;
    throw new ApiError("validation_failed", "The payment intent input is invalid.", { fields: Array.isArray(fields) ? fields : [] });
  }
  if (name === "ReferenceInvalid") throw new ApiError("reference_invalid", "reference must be 1-200 characters of [A-Za-z0-9:_-].");
  if (name === "ReferenceConflict") throw new ApiError("reference_conflict", "A payment intent with this reference already exists with a different amount or chain.");
  // IntentKeyMismatch is a caller bug (auth resolved key + client): falls through to 500 internal.
  if (name === "AmountOutOfRange") throw new ApiError("amount_out_of_range", "amount is outside this account's allowed range for a payment intent.");
  if (name === "UnsupportedChain") throw new ApiError("unsupported_chain", "This chain is not enabled for this account.");
  if (name === "DerivationUnavailable") throw new ApiError("derivation_unavailable", "Address derivation is unavailable; nothing was created. Retry later.");
  if (name === "ChainUnavailable") throw new ApiError("chain_unavailable", "The chain layer is unavailable; nothing was created. Retry later.");
  throw e;
}

export const paymentIntents = new Hono();
paymentIntents.use("*", bearerAuth);

paymentIntents.post("/", scope("payment_intents.write"), idempotent, async (c) => {
  const key = c.get("key");
  const parsed = Body.safeParse(await c.req.json());
  if (!parsed.success) throw new ApiError("validation_failed", "Body must be { amount: string, chain, reference, expires_in_sec?: 300..604800 }.", { fields: fieldsOf(parsed.error.issues) });
  const { amount, chain, reference } = parsed.data;
  if (!AMOUNT.test(amount) || /^0(?:\.0+)?$/.test(amount)) {
    throw new ApiError("amount_out_of_range", "amount must be a decimal string greater than 0 with at most 6 decimals.", { amount });
  }
  if (!(CHAINS as readonly string[]).includes(chain)) throw new ApiError("unsupported_chain", "chain must be TRC20 or BEP20 and enabled for this account.", { chain });
  if (!REFERENCE.test(reference)) throw new ApiError("reference_invalid", "reference must be 1-200 characters of [A-Za-z0-9:_-].");
  const client = await prisma.client.findUnique({ where: { id: key.clientId }, select: { minIntent: true, maxIntent: true, enabledChains: true } });
  if (!client) throw new ApiError("invalid_key", "Invalid API key.");
  if (!client.enabledChains.includes(chain as Chain)) throw new ApiError("unsupported_chain", `${chain} is not enabled for this account.`, { chain });
  if (client.minIntent.gt(amount) || client.maxIntent.lt(amount)) {
    throw new ApiError("amount_out_of_range", `amount must be between ${client.minIntent.toFixed()} and ${client.maxIntent.toFixed()}.`, { min: client.minIntent.toFixed(), max: client.maxIntent.toFixed() });
  }
  const expiresInSec = parsed.data.expires_in_sec ?? 3600;
  // Resolved BEFORE anything is created: a config failure after createIntent
  // would be a 5xx, the idempotency row would be `failed`, and the retry
  // would create a second intent.
  confirmationsRequired(chain as Chain);

  // v1.1 A7: one intent per (client, reference). The same reference with the
  // same amount + chain IS the existing intent (a store retry with a fresh
  // Idempotency-Key); a different amount or chain is 409 reference_conflict.
  // G6's UNIQUE(client_id, reference) is what holds under a race; this read
  // is the clean answer for the ordinary case.
  const existing = await existingForReference(key.clientId, reference, amount, chain as Chain);
  if (existing) return c.json(renderIntent(existing), 200);

  let created: { id: string };
  if (!createIntentImpl) throw new Error("port not wired: createIntent (src/server.ts bootApi must install it)");
  try { created = await createIntentImpl(key.clientId, key.id, { amount, chain: chain as Chain, reference, expiresInSec }); }
  catch (e) {
    if ((e instanceof Error && e.name === "ReferenceConflict") || (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) {
      // Lost the UNIQUE(client_id, reference) race (G2 answers ReferenceConflict,
      // or the raw P2002): the winner's row decides — 200 the same, 409 a different one.
      const winner = await existingForReference(key.clientId, reference, amount, chain as Chain);
      if (winner) return c.json(renderIntent(winner), 200);
    }
    logger.warn({ actor: `key:${key.id}`, action: "payment_intent.create", result: "refused", reason: e instanceof Error ? e.name : "unknown", requestId: c.get("requestId") }, "payment intent not created");
    mapCreateError(e);
  }
  const row = await readIntent(key.clientId, created.id);
  if (!row) throw new Error(`createIntent returned ${created.id}, which this client cannot read back`);
  logger.info({ actor: `key:${key.id}`, action: "payment_intent.create", result: "created", intentId: row.id, chain: row.chain, amount: row.amount.toFixed(), requestId: c.get("requestId") }, "payment intent created");
  return c.json(renderIntent(row), 201);
});

paymentIntents.get("/:id", scope("payment_intents.read"), async (c) => {
  const row = await readIntent(c.get("key").clientId, c.req.param("id"));
  if (!row) throw new ApiError("not_found", "No such payment intent.");
  return c.json(renderIntent(row), 200);
});

paymentIntents.get("/", scope("payment_intents.read"), async (c) => {
  const clientId = c.get("key").clientId;
  const q = ListQuery.safeParse(c.req.query());
  if (!q.success) throw new ApiError("validation_failed", "Query must be ?reference=&status=&limit=1..100&starting_after=.", { fields: fieldsOf(q.error.issues) });
  const { reference, status, limit, starting_after } = q.data;
  // Cursor: newest first, (created_at, id) descending. The cursor must be the
  // caller's own intent — a foreign id is 404, the same as an unknown one.
  let before: { createdAt: Date; id: string } | null = null;
  if (starting_after) {
    before = await prisma.paymentIntent.findFirst({ where: { id: starting_after, clientId }, select: { createdAt: true, id: true } });
    if (!before) throw new ApiError("not_found", "starting_after names no payment intent of this account.");
  }
  const rows = await prisma.paymentIntent.findMany({
    where: {
      clientId, ...(reference ? { reference } : {}), ...(status ? { status } : {}),
      ...(before ? { OR: [{ createdAt: { lt: before.createdAt } }, { createdAt: before.createdAt, id: { lt: before.id } }] } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1, select: INTENT_SELECT,
  });
  return c.json({ object: "list", data: rows.slice(0, limit).map(renderIntent), has_more: rows.length > limit }, 200);
});
