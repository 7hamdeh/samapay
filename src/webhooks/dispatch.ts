// Delivery with backoff. NOTIFICATION, NEVER SOURCE: a client that receives
// deposit.confirmed must GET /deposits before crediting anyone; losing a
// webhook loses nothing. Schedule copied from SamaPrime's dispatcher.
import type { Prisma } from "@prisma/client";
import { prisma } from "@/db/client.js";
import { EVENT_HEADER, SIGNATURE_HEADER, signPayload } from "./sign.js";

export const RETRY_SCHEDULE_MS = [1_000, 5_000, 30_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000, 24 * 60 * 60_000] as const;
export const MAX_ATTEMPTS = RETRY_SCHEDULE_MS.length;
const TIMEOUT_MS = 10_000;

export type EventType = "deposit.confirmed" | "withdrawal.sent" | "withdrawal.failed";

/** Enqueue one delivery for a key; the worker delivers. Idempotent per (key, eventId). */
export async function enqueue(keyId: string, eventType: EventType, eventId: string, data: Record<string, unknown>) {
  const existing = await prisma.webhookDelivery.findFirst({ where: { keyId, eventId }, select: { id: true } });
  if (existing) return existing.id;
  const payload = { id: eventId, type: eventType, created_at: new Date().toISOString(), data } as unknown as Prisma.InputJsonObject;
  const row = await prisma.webhookDelivery.create({ data: { keyId, eventType, eventId, payload, nextAttemptAt: new Date() }, select: { id: true } });
  return row.id;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number }>;

/** One attempt. Returns what happened; the schedule decides what is next. */
export async function attemptDelivery(deliveryId: string, fetchImpl: FetchLike = (u, i) => fetch(u, i)) {
  const d = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: deliveryId }, include: { key: { select: { webhookUrl: true, webhookSecret: true } } } });
  if (d.status === "delivered" || d.status === "exhausted") return { outcome: d.status as "delivered" | "exhausted" };
  if (!d.key.webhookUrl || !d.key.webhookSecret) {
    await prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: "exhausted", lastError: "no webhook url/secret on key" } });
    return { outcome: "exhausted" as const };
  }
  const rawBody = JSON.stringify(d.payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let statusCode = 0, error: string | null = null;
  try {
    const res = await fetchImpl(d.key.webhookUrl, { method: "POST", headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signPayload(d.key.webhookSecret, rawBody), [EVENT_HEADER]: d.eventType }, body: rawBody, signal: controller.signal });
    statusCode = res.status;
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 500) : String(e);
  } finally { clearTimeout(timer); }
  const attempts = d.attempts + 1;
  const ok = statusCode >= 200 && statusCode < 300;
  if (ok) {
    await prisma.webhookDelivery.update({ where: { id: d.id }, data: { attempts, status: "delivered", lastStatusCode: statusCode, deliveredAt: new Date(), nextAttemptAt: null } });
    return { outcome: "delivered" as const, attempts };
  }
  const exhausted = attempts >= MAX_ATTEMPTS;
  const delay = RETRY_SCHEDULE_MS[Math.min(attempts, MAX_ATTEMPTS - 1)] as number;
  await prisma.webhookDelivery.update({ where: { id: d.id }, data: { attempts, status: exhausted ? "exhausted" : "pending", lastStatusCode: statusCode || null, lastError: error, nextAttemptAt: exhausted ? null : new Date(Date.now() + delay) } });
  return { outcome: exhausted ? ("exhausted" as const) : ("retry" as const), attempts, nextInMs: exhausted ? null : delay };
}
