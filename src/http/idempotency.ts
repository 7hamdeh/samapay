// IDEMPOTENCY — contract §3, the SamaPrime engine's shape re-implemented, not imported.
//   header           Idempotency-Key REQUIRED on every POST, 1–255 printable ASCII
//   scope            (key_id, Idempotency-Key)      never global
//   request hash     sha256(method, path, CANONICAL JSON of the body) — key
//                    order and whitespace do not make two bodies different
//   claim            fast INSERT of a `processing` row; work happens OUTSIDE any
//                    long transaction (Stripe's shape; Prisma's 5 s interactive
//                    transaction timeout is why)
//   replay same hash -> the stored status + body (byte-identical), header Idempotent-Replayed: true
//   replay diff hash -> 409 idempotency_payload_mismatch
//   in progress      -> 409 idempotency_in_progress (stale locks reclaimed after 90 s)
//   5xx              -> row `failed`: the same key may retry (nothing was created)
//   ttl              24 h, then the key may be reused with any payload
// Every reclaim is a CONDITIONAL update on the state we read, so two
// requests racing to reclaim the same row cannot both win.
import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { Prisma } from "@prisma/client";
import { prisma } from "@/db/client.js";
import { ApiError } from "./errors.js";

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const STALE_LOCK_MS = 90 * 1000;
const HEADER = "idempotency-key";
const VALID_KEY = /^[\x20-\x7e]{1,255}$/;

/** Stable JSON: object keys sorted at every depth; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function hashRequest(method: string, path: string, canonicalBody: string): string {
  return createHash("sha256").update(`${method}\n${path}\n${canonicalBody}`).digest("hex");
}

/** Wrap a mutating route. The handler runs at most once per (key, Idempotency-Key, payload). */
export const idempotent: MiddlewareHandler = async (c, next) => {
  const key = c.get("key");
  const idemKey = c.req.header(HEADER) ?? "";
  if (!VALID_KEY.test(idemKey)) throw new ApiError("idempotency_key_required", "Idempotency-Key header is required on every POST (1-255 printable ASCII characters).");
  // The body must be JSON before anything is claimed: a garbage body never
  // occupies a key. The route reads it again via c.req.json(); Hono caches it.
  let parsed: unknown;
  try { parsed = JSON.parse(await c.req.text()); } catch { throw new ApiError("invalid_json", "The request body is not valid JSON."); }
  const requestHash = hashRequest(c.req.method, new URL(c.req.url).pathname, canonicalJson(parsed));
  const now = new Date();
  const where = { keyId_idemKey: { keyId: key.id, idemKey } };

  // CLAIM. The unique (key_id, idem_key) is the lock; a P2002 means someone holds it.
  let claimed = false;
  try {
    await prisma.idempotencyKey.create({ data: { keyId: key.id, idemKey, requestHash, status: "processing", lockedAt: now, expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS) } });
    claimed = true;
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
  }
  if (!claimed) {
    const existing = await prisma.idempotencyKey.findUniqueOrThrow({ where });
    const inProgress = () => new ApiError("idempotency_in_progress", "A request with this Idempotency-Key is still in progress; retry after 1 second.");
    if (existing.expiresAt <= now) {
      // Expired: reclaim with the new payload — only if nobody else just did.
      const won = await prisma.idempotencyKey.updateMany({
        where: { id: existing.id, expiresAt: existing.expiresAt },
        data: { requestHash, status: "processing", statusCode: null, responseBody: Prisma.DbNull, lockedAt: now, expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS) },
      });
      if (won.count !== 1) throw inProgress();
    } else if (existing.requestHash !== requestHash) {
      throw new ApiError("idempotency_payload_mismatch", "This Idempotency-Key was already used with a different request body.");
    } else if (existing.status === "completed" && existing.statusCode !== null) {
      c.header("Idempotent-Replayed", "true");
      // Stored as the RAW response text (a JSON string value), so the replay
      // is byte-identical — jsonb would re-order the keys of an object.
      // Rows written before that change hold the parsed object.
      if (typeof existing.responseBody === "string") {
        return c.body(existing.responseBody, existing.statusCode as 200, { "Content-Type": "application/json; charset=UTF-8" });
      }
      return c.json(existing.responseBody as Record<string, unknown>, existing.statusCode as 200);
    } else if (existing.status === "processing" && now.getTime() - existing.lockedAt.getTime() < STALE_LOCK_MS) {
      throw inProgress();
    } else {
      // failed, or a stale processing lock: reclaim under the same hash.
      const won = await prisma.idempotencyKey.updateMany({
        where: { id: existing.id, status: existing.status, lockedAt: existing.lockedAt },
        data: { status: "processing", lockedAt: now },
      });
      if (won.count !== 1) throw inProgress();
    }
  }

  // WORK — outside any transaction of ours. A thrown ApiError has already
  // been turned into c.res by the app's onError when next() returns.
  let response: Response;
  try {
    await next();
    response = c.res;
  } catch (e) {
    await prisma.idempotencyKey.update({ where, data: { status: "failed" } }).catch(() => undefined);
    throw e;
  }
  // RECORD the final state; a 5xx is `failed` (retryable), everything else `completed`.
  const status = response.status;
  const text = await response.clone().text();
  await prisma.idempotencyKey.update({
    where,
    data: status >= 500 ? { status: "failed" } : { status: "completed", statusCode: status, responseBody: text },
  });
};

export function idempotencyHeaderName(): string { return HEADER; }
