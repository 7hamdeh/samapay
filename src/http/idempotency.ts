// IDEMPOTENCY — the SamaPrime engine's CONTRACT, re-implemented, not imported.
//   scope            (key_id, Idempotency-Key)      never global
//   claim            fast INSERT of a `processing` row; work happens OUTSIDE any
//                    long transaction (Stripe's shape; Prisma's 5 s interactive
//                    transaction timeout is why)
//   replay same hash -> the stored status + body, header Idempotent-Replayed: true
//   replay diff hash -> 409 idempotency_payload_mismatch
//   in progress      -> 409 idempotency_key_in_progress (stale locks reclaimed after 90 s)
//   ttl              24 h, then the key may be reused with any payload
import { createHash } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { Prisma } from "@prisma/client";
import { prisma } from "@/db/client.js";
import { ApiError } from "./errors.js";

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const STALE_LOCK_MS = 90 * 1000;
const HEADER = "idempotency-key";

export function hashRequest(method: string, path: string, body: string): string {
  return createHash("sha256").update(`${method}\n${path}\n${body}`).digest("hex");
}

/** Wrap a mutating route. The handler runs at most once per (key, Idempotency-Key, payload). */
export const idempotent: MiddlewareHandler = async (c, next) => {
  const key = c.get("key");
  const idemKey = c.req.header(HEADER)?.trim() ?? "";
  if (!idemKey || idemKey.length > 200) throw new ApiError("idempotency_key_required", "Idempotency-Key header is required on this request (1-200 chars).");
  const body = await c.req.text();
  const requestHash = hashRequest(c.req.method, new URL(c.req.url).pathname, body);
  const now = new Date();

  // CLAIM. The unique (key_id, idem_key) is the lock; a P2002 means someone holds it.
  let claimed = false;
  try {
    await prisma.idempotencyKey.create({ data: { keyId: key.id, idemKey, requestHash, status: "processing", lockedAt: now, expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS) } });
    claimed = true;
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
  }
  if (!claimed) {
    const existing = await prisma.idempotencyKey.findUniqueOrThrow({ where: { keyId_idemKey: { keyId: key.id, idemKey } } });
    if (existing.expiresAt <= now) {
      // Expired: reclaim with the new payload.
      await prisma.idempotencyKey.update({ where: { id: existing.id }, data: { requestHash, status: "processing", statusCode: null, responseBody: Prisma.JsonNull, lockedAt: now, expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS) } });
    } else if (existing.requestHash !== requestHash) {
      throw new ApiError("idempotency_payload_mismatch", "This Idempotency-Key was already used with a different request body.");
    } else if (existing.status === "completed" && existing.statusCode !== null) {
      c.header("Idempotent-Replayed", "true");
      return c.json(existing.responseBody as Record<string, unknown>, existing.statusCode as 200);
    } else if (existing.status === "processing" && now.getTime() - existing.lockedAt.getTime() < STALE_LOCK_MS) {
      throw new ApiError("idempotency_key_in_progress", "A request with this Idempotency-Key is still in progress.");
    } else {
      // failed, or a stale processing lock: reclaim under the same hash.
      await prisma.idempotencyKey.update({ where: { id: existing.id }, data: { status: "processing", lockedAt: now } });
    }
  }

  // WORK — outside any transaction of ours. The route reads the body again
  // via c.req.json(); Hono caches the text we consumed above.
  let response: Response;
  try {
    await next();
    response = c.res;
  } catch (e) {
    await prisma.idempotencyKey.update({ where: { keyId_idemKey: { keyId: key.id, idemKey } }, data: { status: "failed" } }).catch(() => undefined);
    throw e;
  }
  // RECORD the final state; a 5xx is `failed` (retryable), everything else `completed`.
  const status = response.status;
  const text = await response.clone().text();
  let json: Prisma.InputJsonValue = {};
  try { json = JSON.parse(text) as Prisma.InputJsonValue; } catch { json = { raw: text }; }
  await prisma.idempotencyKey.update({
    where: { keyId_idemKey: { keyId: key.id, idemKey } },
    data: status >= 500 ? { status: "failed" } : { status: "completed", statusCode: status, responseBody: json },
  });
};

export function idempotencyHeaderName(): string { return HEADER; }
export type { Context };
