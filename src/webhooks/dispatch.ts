// Delivery with backoff. NOTIFICATION, NEVER SOURCE: a client that receives
// an event must re-fetch the object before crediting anyone; losing a
// webhook loses nothing. Schedule: API contract §7.
//
// payment_intent.* and deposit.confirmed are born in src/events (enqueueEvent,
// inside the state change's transaction). `enqueue` below remains for the
// withdrawal.* notifications, which are out of Phase 0.
//
// Contract v1.1:
//   A6 — a delivery goes to the CLIENT's current active key (its URL, its
//        secret), not to the key it was enqueued under: after a rotation the
//        old key's events still arrive, signed with the secret the receiver
//        now holds.
//   A7 — an attempt starts with a CLAIM: one conditional UPDATE that only one
//        worker can win, and only when the attempt is DUE. The claim is a
//        LEASE on `next_attempt_at` — the winner moves it CLAIM_LEASE_MS into
//        the future, so the row is not due for anyone else while it sends.
//        No `sending` status and no new column: a worker that dies mid-attempt
//        leaves a `pending` row whose lease simply expires, and the existing
//        worker query (pending AND next_attempt_at <= now) picks it up again.
//        Every write after the claim is fenced by the lease value, so a late
//        result from an expired lease can never overwrite a newer attempt.
import { Prisma } from "@prisma/client";
import { prisma } from "@/db/client.js";
import { logger } from "@/log.js";
import { depositEventSuppression, EventObjectNotFound } from "@/events/index.js";
import { decryptWebhookSecret, WebhookSecretUnreadable } from "@/keys/webhook-secret.js";
import { DELIVERY_HEADER, EVENT_HEADER, SIGNATURE_HEADER, signPayload } from "./sign.js";

const MIN = 60_000, HOUR = 60 * MIN;
/** The wait AFTER failed attempt n (1-based) is RETRY_SCHEDULE_MS[n-1]. */
export const RETRY_SCHEDULE_MS = [1 * MIN, 5 * MIN, 30 * MIN, 2 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR] as const;
/** The first attempt + one per scheduled retry. The last failure is `exhausted`. */
export const MAX_ATTEMPTS = RETRY_SCHEDULE_MS.length + 1;
export const TIMEOUT_MS = 10_000;
/**
 * How long a claim holds the row. A lease older than this belongs to a worker
 * that died mid-attempt and is taken over. It must exceed TIMEOUT_MS by a
 * wide margin: a live attempt can never still be running when its lease ends.
 */
export const CLAIM_LEASE_MS = 60_000;

const log = logger.child({ module: "webhooks" });

export type EventType = "deposit.confirmed" | "withdrawal.sent" | "withdrawal.failed" | "withdrawal.cancelled" | "withdrawal.refunded";

/**
 * Enqueue one delivery for a key; the worker delivers. Idempotent per (key, eventId).
 * @deprecated for deposit.confirmed — use enqueueEvent from @/events inside the
 * confirming transaction. A deposit.confirmed that still arrives this way is
 * held to the same watch rule at SEND time (attemptDelivery below).
 */
export async function enqueue(keyId: string, eventType: EventType, eventId: string, data: Record<string, unknown>) {
  const existing = await prisma.webhookDelivery.findUnique({ where: { keyId_eventId: { keyId, eventId } }, select: { id: true } });
  if (existing) return existing.id;
  const { clientId } = await prisma.clientKey.findUniqueOrThrow({ where: { id: keyId }, select: { clientId: true } });
  const payload = { id: eventId, type: eventType, created_at: new Date().toISOString(), data } as unknown as Prisma.InputJsonObject;
  try {
    const row = await prisma.webhookDelivery.create({ data: { keyId, clientId, eventType, eventId, payload, nextAttemptAt: new Date() }, select: { id: true } });
    return row.id;
  } catch (e) {
    // UNIQUE(key_id, event_id): a concurrent enqueue of the same event won; return its row.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return (await prisma.webhookDelivery.findUniqueOrThrow({ where: { keyId_eventId: { keyId, eventId } }, select: { id: true } })).id;
    throw e;
  }
}

/** The deposit a deposit.confirmed delivery is about, from either enqueue path. */
function depositRowIdOf(d: { eventType: string; eventId: string; payload: Prisma.JsonValue }): string | null {
  if (d.eventType !== "deposit.confirmed") return null;
  if (d.eventId.startsWith("dep_")) return d.eventId.slice("dep_".length); // legacy enqueue: eventId = dep_<row id>
  const obj = (d.payload as { data?: { object?: { id?: unknown } } } | null)?.data?.object; // envelope: data.object.id = dep_<row id>
  return typeof obj?.id === "string" && obj.id.startsWith("dep_") ? obj.id.slice("dep_".length) : null;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number }>;

export type AttemptOutcome =
  | { outcome: "delivered"; attempts?: number } // no attempts: it was already delivered before this call
  | { outcome: "retry"; attempts: number; nextInMs: number }
  | { outcome: "exhausted"; attempts?: number }
  | { outcome: "suppressed"; reason: string }
  | { outcome: "not_claimed" }
  | { outcome: "failed" };

/** One attempt. Returns what happened; the schedule decides what is next. */
export async function attemptDelivery(deliveryId: string, fetchImpl: FetchLike = (u, i) => fetch(u, { ...i, redirect: "manual" })): Promise<AttemptOutcome> {
  // ── THE CLAIM (A7) ── only a DUE pending row; the winner takes a lease.
  const now = new Date();
  const lease = new Date(now.getTime() + CLAIM_LEASE_MS);
  const won = await prisma.webhookDelivery.updateMany({
    where: { id: deliveryId, status: "pending", nextAttemptAt: { lte: now } },
    data: { nextAttemptAt: lease },
  });
  if (won.count !== 1) {
    const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: deliveryId }, select: { status: true } });
    if (row.status === "delivered") return { outcome: "delivered" };
    if (row.status === "exhausted") return { outcome: "exhausted" };
    if (row.status === "failed") return { outcome: "failed" };
    return { outcome: "not_claimed" }; // not due yet, or another worker holds the lease
  }
  // Every write from here on is fenced by OUR lease: if it expired and another
  // worker took over, our late result is dropped, not written over its.
  const mine = { id: deliveryId, status: "pending" as const, nextAttemptAt: lease };
  const finish = async (data: Prisma.WebhookDeliveryUpdateManyMutationInput) => {
    const r = await prisma.webhookDelivery.updateMany({ where: mine, data });
    if (r.count !== 1) log.warn({ actor: "webhooks", action: "webhook.deliver", result: "lease_lost", deliveryId }, "lease expired before the result was written");
  };

  const d = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: deliveryId }, include: { key: { select: { clientId: true } } } });
  const attempts = d.attempts + 1;
  const fail = async (error: string, statusCode: number | null): Promise<AttemptOutcome> => {
    const exhausted = attempts >= MAX_ATTEMPTS;
    const delay = exhausted ? null : (RETRY_SCHEDULE_MS[attempts - 1] as number);
    await finish({ attempts, status: exhausted ? "exhausted" : "pending", lastStatusCode: statusCode, lastError: error.slice(0, 500), nextAttemptAt: delay === null ? null : new Date(Date.now() + delay) });
    log.warn({ actor: "webhooks", action: "webhook.deliver", result: exhausted ? "exhausted" : "retry", deliveryId, eventId: d.eventId, attempts, statusCode, error, nextInMs: delay }, "delivery failed");
    return delay === null ? { outcome: "exhausted", attempts } : { outcome: "retry", attempts, nextInMs: delay };
  };

  // ⚠️ deposit.confirmed never goes out for a watch-disabled address or a
  // legacy address SamaPay does not watch yet. enqueueEvent never creates one;
  // this re-check at send time is what holds for a row that came in through
  // the legacy `enqueue` path.
  const depositRowId = depositRowIdOf(d);
  if (depositRowId) {
    let reason: Awaited<ReturnType<typeof depositEventSuppression>>;
    try { reason = await depositEventSuppression(prisma, depositRowId); }
    catch (e) { if (e instanceof EventObjectNotFound) return fail(e.message, null); throw e; }
    if (reason) {
      await finish({ status: "failed", lastError: `suppressed: ${reason}`, nextAttemptAt: null });
      log.info({ actor: "webhooks", action: "webhook.deliver", result: "suppressed", deliveryId, reason }, "no deposit.confirmed for this address");
      return { outcome: "suppressed", reason };
    }
  }

  // ── THE TARGET (A6) ── the client's current active key, newest first.
  const target = await prisma.clientKey.findFirst({
    where: { clientId: d.key.clientId, active: true, revokedAt: null, webhookUrl: { not: null }, webhookSecret: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { id: true, webhookUrl: true, webhookSecret: true },
  });
  // No key to send to is a failed ATTEMPT, not a lost event: it stays on the
  // schedule (and redrive-deliveries.ts can bring it back after exhaustion).
  if (!target?.webhookUrl || !target.webhookSecret) return fail("no active key with a webhook url for this client", null);

  // ⚠️ SIGN WITH THE DECRYPTED SECRET, NEVER THE COLUMN. The column holds AEAD
  // ciphertext (src/keys/webhook-secret.ts); this line used to pass the column
  // straight to signPayload, so every receiver holding the real secret would
  // have rejected every delivery. A column that does not decrypt is REFUSED —
  // there is no fallback to its raw bytes.
  let secret: string;
  try { secret = decryptWebhookSecret(target.webhookSecret); }
  catch (e) {
    if (!(e instanceof WebhookSecretUnreadable)) throw e;
    await finish({ status: "exhausted", lastError: e.message.slice(0, 500), nextAttemptAt: null });
    log.error({ actor: "webhooks", action: "webhook.deliver", result: "exhausted", deliveryId, keyId: target.id, reason: "secret_unreadable" }, "webhook secret does not decrypt");
    return { outcome: "exhausted" };
  }
  const rawBody = JSON.stringify(d.payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
  let statusCode = 0, error: string | null = null;
  try {
    const res = await fetchImpl(target.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", [EVENT_HEADER]: d.eventType, [DELIVERY_HEADER]: d.id, [SIGNATURE_HEADER]: signPayload(secret, rawBody) },
      body: rawBody,
      signal: controller.signal,
    });
    statusCode = res.status;
  } catch (e) {
    error = controller.signal.aborted ? `timeout after ${TIMEOUT_MS} ms` : e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 500) : String(e);
  } finally { clearTimeout(timer); }
  if (statusCode >= 200 && statusCode < 300) {
    await finish({ attempts, status: "delivered", lastStatusCode: statusCode, lastError: null, deliveredAt: new Date(), nextAttemptAt: null });
    log.info({ actor: "webhooks", action: "webhook.deliver", result: "delivered", deliveryId, eventId: d.eventId, keyId: target.id, attempts, statusCode }, "delivered");
    return { outcome: "delivered", attempts };
  }
  return fail(error ?? `HTTP ${statusCode}`, statusCode || null);
}
