// Bearer auth — the shape SamaPrime actually ships (lib/api/auth.ts), not
// the planned 3-header design: one header, prefix lookup, argon2 verify of
// the full key, scopes on the row. Timing-safe by construction (argon2).
//
// Contract §6 splits the old single `unauthorized` into three 401 codes:
//   unauthenticated  the header is missing or malformed
//   invalid_key      unknown prefix, or the argon2 verify fails
//   key_revoked      revoked or inactive — decided ONLY AFTER the full key
//                    verifies, so a caller who does not hold the key learns
//                    nothing (a wrong secret on a revoked key is invalid_key).
// Then the per-key rate limit (§2): 429 rate_limited with Retry-After.
import type { Context, MiddlewareHandler } from "hono";
import type { ClientKey } from "@prisma/client";
import { prisma } from "@/db/client.js";
import { keyPrefixOf, verifyKey } from "@/keys/generate.js";
import { ApiError } from "./errors.js";
import type { Scope } from "./scopes.js";

export type AuthedKey = Pick<ClientKey, "id" | "clientId" | "keyPrefix" | "scopes" | "environment" | "active" | "rpsLimit">;

declare module "hono" {
  interface ContextVariableMap { key: AuthedKey }
}

function clientIp(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";
}

// Contract §2: sk_test_ keys on NON-production only. Production is either
// signal — NODE_ENV=production or CRYPTO_MODE=mainnet (real money) — so a
// deployment that forgot one of them still refuses test keys (fail closed).
export function testKeysAllowed(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.CRYPTO_MODE !== "mainnet";
}

export async function authenticate(authorization: string | undefined): Promise<AuthedKey> {
  const m = /^Bearer\s+(sk_(live|test)_[a-z2-7]{40})$/.exec(authorization ?? "");
  if (!m) throw new ApiError("unauthenticated", 'Missing or malformed Authorization header — expected "Bearer sk_live_…".');
  const plaintext = m[1] as string;
  // Decided from the key's own form, before any lookup or argon2 work.
  if (m[2] === "test" && !testKeysAllowed()) throw new ApiError("invalid_key", "Test keys are not accepted in production.");
  const prefix = keyPrefixOf(plaintext);
  // Pre-argon2 brake: see FAILED_VERIFY_* below.
  const wait = failedVerifyWait(prefix);
  if (wait > 0) throw new ApiError("rate_limited", "Too many failed authentications for this key; retry later.", { retry_after_sec: wait });
  const row = await prisma.clientKey.findUnique({
    where: { keyPrefix: prefix },
    select: { id: true, clientId: true, keyPrefix: true, keyHash: true, scopes: true, environment: true, active: true, rpsLimit: true, revokedAt: true, successorKeyId: true },
  });
  // Same error for unknown prefix and wrong secret: a caller must not learn which.
  if (!row) throw new ApiError("invalid_key", "Invalid API key.");
  argon2Verifies++;
  if (!(await verifyKey(row.keyHash, plaintext))) { recordFailedVerify(prefix); throw new ApiError("invalid_key", "Invalid API key."); }
  if (row.environment === "test" && !testKeysAllowed()) throw new ApiError("invalid_key", "Test keys are not accepted in production.");
  if (!row.active || row.revokedAt) {
    const successor = row.successorKeyId
      ? await prisma.clientKey.findUnique({ where: { id: row.successorKeyId }, select: { keyLast4: true } })
      : null;
    throw new ApiError("key_revoked", "This API key has been revoked.", successor ? { successor: successor.keyLast4 } : undefined);
  }
  const { keyHash: _drop, revokedAt: _drop2, successorKeyId: _drop3, ...safe } = row;
  void _drop; void _drop2; void _drop3;
  return safe;
}

// ── PRE-ARGON2 BRAKE (Q M1) ─────────────────────────────────────────────────
// An unknown prefix never reaches argon2, but a KNOWN prefix (12 chars, shown
// in the CLI output and logs) with wrong secrets would make every request pay
// a full argon2 verify. Failed verifies are counted per prefix; after a burst
// of FAILED_VERIFY_BURST the prefix is answered 429 BEFORE any lookup or
// argon2 until the bucket refills (FAILED_VERIFY_PER_SEC). Successful requests
// never consume it. TRADE-OFF, stated: while someone floods a prefix with
// wrong secrets, the real holder of that key is also answered 429 — degraded
// service, never access. In-process, like the per-key limiter below. A
// per-IP brake needs a trusted client IP (nginx X-Real-IP), which Phase 0
// (loopback only) does not have: that is a pre-public-exposure item.
// TEST SEAM (read-only): how many argon2 verifies this process has run. The
// brake's whole claim is "no argon2 once engaged", and a count is the only
// thing that can tell a pre-argon2 brake from one placed after the verify.
let argon2Verifies = 0;
export function argon2VerifyCount(): number { return argon2Verifies; }

export const FAILED_VERIFY_BURST = 10;
export const FAILED_VERIFY_PER_SEC = 1;
const failed = new Map<string, Bucket>();
function refill(b: Bucket, rate: number, cap: number, now: number): void {
  b.tokens = Math.min(cap, b.tokens + ((now - b.at) / 1000) * rate); b.at = now;
}
function failedVerifyWait(prefix: string, now = Date.now()): number {
  const b = failed.get(prefix);
  if (!b) return 0;
  refill(b, FAILED_VERIFY_PER_SEC, FAILED_VERIFY_BURST, now);
  if (b.tokens >= 1) return 0;
  return Math.max(1, Math.ceil((1 - b.tokens) / FAILED_VERIFY_PER_SEC));
}
function recordFailedVerify(prefix: string, now = Date.now()): void {
  const b = failed.get(prefix) ?? { tokens: FAILED_VERIFY_BURST, at: now };
  refill(b, FAILED_VERIFY_PER_SEC, FAILED_VERIFY_BURST, now);
  b.tokens = Math.max(0, b.tokens - 1);
  failed.set(prefix, b);
}

// ── RATE LIMIT ─────────────────────────────────────────────────────────────
// A token bucket per key: capacity = rps_limit, refilled at rps_limit per
// second. IN-PROCESS: correct for the one API process Phase 0 runs; a second
// process would give each its own bucket (the limit becomes N × rps_limit).
interface Bucket { tokens: number; at: number }
const buckets = new Map<string, Bucket>();

/** Take one token for `keyId`; returns 0 when allowed, else whole seconds to wait (≥ 1). */
export function takeToken(keyId: string, rpsLimit: number, now = Date.now()): number {
  const rate = Math.max(1, rpsLimit);
  const b = buckets.get(keyId) ?? { tokens: rate, at: now };
  b.tokens = Math.min(rate, b.tokens + ((now - b.at) / 1000) * rate);
  b.at = now;
  buckets.set(keyId, b);
  if (b.tokens >= 1) { b.tokens -= 1; return 0; }
  return Math.max(1, Math.ceil((1 - b.tokens) / rate));
}

export const bearerAuth: MiddlewareHandler = async (c, next) => {
  const key = await authenticate(c.req.header("authorization"));
  c.set("key", key);
  const wait = takeToken(key.id, key.rpsLimit);
  if (wait > 0) {
    c.header("Retry-After", String(wait));
    throw new ApiError("rate_limited", `Rate limit of ${key.rpsLimit} requests per second exceeded.`, { retry_after_sec: wait });
  }
  // Bookkeeping, never on the request's critical path and never a row lock
  // anyone waits on (see the ClientKey model comment on the advisory lock).
  void prisma.clientKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date(), lastUsedIp: clientIp(c) } }).catch(() => undefined);
  await next();
};

export function requireScope(key: AuthedKey, scope: Scope): void {
  if (!key.scopes.includes(scope)) throw new ApiError("insufficient_scope", `This key is missing the required scope "${scope}".`, { required: scope });
}

/** Route-level form of requireScope, so the check runs BEFORE the idempotency claim. */
export function scope(s: Scope): MiddlewareHandler {
  return async (c, next) => { requireScope(c.get("key"), s); await next(); };
}
