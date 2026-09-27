// Panel sessions. The cookie is a 256-bit random token; the row keeps only its
// sha256, so a database read cannot mint a live cookie and a log line that
// catches a request header cannot be replayed by whoever reads the log.
//
// COOKIE SHAPE, and why each bit:
//  · HOST-ONLY: no `domain` attribute is ever set. The instant this cookie is
//    scoped to `.mntad.com` it is sent to every other host on that estate
//    (and read by any subdomain takeover) — pay-dashboard.md A.12 is explicit
//    that SamaPay's own session stays narrower than MNTAD's `.mntad.com` cookie.
//  · HttpOnly — the panel has no reason for page script to read its own auth.
//  · SameSite=Lax — a top-level GET navigation still arrives (the handoff
//    redirect is a GET), a cross-site POST does not.
//  · Secure — always. The panel is only ever served over the pay.mntad.com
//    vhost, which has HSTS; a cookie that survives plain http is a cookie
//    strippable by anyone on the path.
//  · TTL ≤ config.sessionTtlSec (12 h default). See config.ts for why not 30 d.
import { createHash } from "node:crypto";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import { prisma } from "@/db/client.js";
import { randomToken, sha256Hex } from "./crypto.js";
import type { PanelConfig } from "./config.js";

export type PanelVia = "otp" | "handoff";

export interface PanelPrincipal {
  accountId: string;
  email: string;
  displayName: string | null;
  sessionId: string;
  csrfToken: string;
  via: PanelVia;
  expiresAt: Date;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(input: {
  accountId: string; via: PanelVia; ip: string | null; userAgent: string | null; cfg: PanelConfig;
}): Promise<{ sessionId: string; token: string; csrfToken: string; expiresAt: Date }> {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const expiresAt = new Date(Date.now() + input.cfg.sessionTtlSec * 1000);
  const row = await prisma.panelSession.create({
    data: { tokenHash: tokenHash(token), accountId: input.accountId, csrfToken, via: input.via, expiresAt, lastSeenIp: input.ip, userAgent: input.userAgent },
    select: { id: true },
  });
  // The TOKEN is the cookie and never appears in an audit row or a log line;
  // the row id is what identifies this session to everything else.
  return { sessionId: row.id, token, csrfToken, expiresAt };
}

/** Revokes nothing and returns null on any mismatch, without saying WHICH
 *  condition failed — an attacker probing session ids learns only that the
 *  answer is the same as for a mistyped cookie. */
export async function loadPrincipal(c: Context, cfg: PanelConfig): Promise<PanelPrincipal | null> {
  const token = getCookie(c, cfg.cookieName);
  if (!token || token.length < 32 || token.length > 128) return null;
  const row = await prisma.panelSession.findUnique({
    where: { tokenHash: sha256Hex(token) },
    select: {
      id: true, accountId: true, csrfToken: true, via: true, expiresAt: true, revokedAt: true,
      account: { select: { id: true, email: true, displayName: true, disabledAt: true } },
    },
  });
  if (!row || row.revokedAt !== null || row.expiresAt <= new Date()) return null;
  if (row.account.disabledAt !== null) return null;
  return Object.freeze({
    accountId: row.account.id, email: row.account.email, displayName: row.account.displayName,
    sessionId: row.id, csrfToken: row.csrfToken, via: row.via as PanelVia, expiresAt: row.expiresAt,
  });
}

/** Sliding freshness on the row only — the cookie's own Max-Age never moves, so
 *  a stolen cookie still dies at the TTL rather than living as long as it is
 *  used. */
export async function touchSession(sessionId: string, ip: string | null): Promise<void> {
  await prisma.panelSession.update({ where: { id: sessionId }, data: { lastSeenAt: new Date(), ...(ip ? { lastSeenIp: ip } : {}) } });
}

export async function revokeSession(sessionId: string): Promise<void> {
  await prisma.panelSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
}

/** Session fixation and "my key might be leaked" both end here: every prior
 *  session for the account dies, then the caller mints the one it is keeping. */
export async function revokeAllSessions(accountId: string, exceptSessionId?: string): Promise<number> {
  const taken = await prisma.panelSession.updateMany({
    where: { accountId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    data: { revokedAt: new Date() },
  });
  return taken.count;
}

export function writeSessionCookies(c: Context, cfg: PanelConfig, token: string, csrfToken: string, expiresAt: Date): void {
  const maxAge = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  setCookie(c, cfg.cookieName, token, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge });
  // Readable by script ON PURPOSE: the double-submit value has to be echoed in
  // a header by the page. It authorizes nothing by itself — without the session
  // cookie above it is a random string.
  setCookie(c, `${cfg.cookieName}_csrf`, csrfToken, { httpOnly: false, secure: true, sameSite: "Lax", path: "/", maxAge });
}

export function clearSessionCookies(c: Context, cfg: PanelConfig): void {
  deleteCookie(c, cfg.cookieName, { path: "/", secure: true, sameSite: "Lax" });
  deleteCookie(c, `${cfg.cookieName}_csrf`, { path: "/", secure: true, sameSite: "Lax" });
}

/** The mutation guard. SameSite=Lax already refuses a cross-site POST; this is
 *  the second lock, and the one that survives a future SameSite change. */
/** The header-only contract of the JSON API. A form cannot set a header, so the
 *  panel's logout form goes through checkCsrfValue with the body field instead —
 *  and ONLY there. One function that read both sources would be a CSRF check
 *  that a cross-origin form can satisfy, which is the exact thing the double
 *  submit exists to prevent. */
export function checkCsrf(c: Context, cfg: PanelConfig, principal: PanelPrincipal): boolean {
  const header = c.req.header("x-csrf-token");
  const cookie = getCookie(c, `${cfg.cookieName}_csrf`);
  return compareTokens(header, principal.csrfToken) && (!cookie || cookie === principal.csrfToken);
}

/** Constant-time equality against the token the SESSION ROW holds. The caller
 *  names where the presented value came from; this function never looks at a
 *  request, so no route can accidentally accept a token from two places. */
export function checkCsrfValue(principal: PanelPrincipal, presented: string | undefined): boolean {
  return compareTokens(presented, principal.csrfToken);
}

function compareTokens(presented: string | undefined, issued: string): boolean {
  if (!presented || presented.length !== issued.length) return false;
  const a = Buffer.from(presented), b = Buffer.from(issued);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
