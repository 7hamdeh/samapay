// Bearer auth — the shape SamaPrime actually ships (lib/api/auth.ts), not
// the planned 3-header design: one header, prefix lookup, argon2 verify of
// the full key, scopes on the row. Timing-safe by construction (argon2).
import type { Context, MiddlewareHandler } from "hono";
import type { ClientKey } from "@prisma/client";
import { prisma } from "@/db/client.js";
import { keyPrefixOf, verifyKey } from "@/keys/generate.js";
import { ApiError } from "./errors.js";
import type { Scope } from "./scopes.js";

export type AuthedKey = Pick<ClientKey, "id" | "clientId" | "keyPrefix" | "scopes" | "environment" | "active">;

declare module "hono" {
  interface ContextVariableMap { key: AuthedKey }
}

function clientIp(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";
}

export async function authenticate(authorization: string | undefined): Promise<AuthedKey> {
  const m = /^Bearer\s+(sk_(?:live|test)_[a-z2-7]{40})$/.exec(authorization ?? "");
  if (!m) throw new ApiError("unauthorized", 'Missing or malformed Authorization header — expected "Bearer sk_live_…".');
  const plaintext = m[1] as string;
  const row = await prisma.clientKey.findUnique({
    where: { keyPrefix: keyPrefixOf(plaintext) },
    select: { id: true, clientId: true, keyPrefix: true, keyHash: true, scopes: true, environment: true, active: true, revokedAt: true },
  });
  // Same error for unknown prefix, wrong secret and revoked key: a caller
  // must not learn which of the three it is.
  if (!row || !row.active || row.revokedAt) throw new ApiError("unauthorized", "Invalid API key.");
  if (!(await verifyKey(row.keyHash, plaintext))) throw new ApiError("unauthorized", "Invalid API key.");
  const { keyHash: _drop, revokedAt: _drop2, ...safe } = row;
  void _drop; void _drop2;
  return safe;
}

export const bearerAuth: MiddlewareHandler = async (c, next) => {
  const key = await authenticate(c.req.header("authorization"));
  c.set("key", key);
  // Bookkeeping, never on the request's critical path and never a row lock
  // anyone waits on (see the ClientKey model comment on the advisory lock).
  void prisma.clientKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date(), lastUsedIp: clientIp(c) } }).catch(() => undefined);
  await next();
};

export function requireScope(key: AuthedKey, scope: Scope): void {
  if (!key.scopes.includes(scope)) throw new ApiError("insufficient_scope", `This key is missing the required scope "${scope}".`, { scope });
}
