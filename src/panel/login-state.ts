// The login page's own state, the handoff ticket's shape applied to a form.
//
// WHAT IT CLOSES. `POST /auth/verify` accepts an email and a code, and mints a
// session for whoever presents them. A page on another site can drive a
// victim's browser through that pair — the attacker asks for a code to THEIR own
// address, watches the victim type nothing, and completes the last step with the
// code the attacker just received. The victim is now signed in to the attacker's
// account, and every deposit they look at that afternoon belongs to somebody
// else. SameSite=Lax already refuses the cross-site POST; this is the second
// lock, and the one that survives a future change to the first.
//
// THE SHAPE: a random value in an HttpOnly cookie, and its sha256 in a hidden
// field. The field is what the browser proves it holds; the cookie is what a
// script on the page cannot read. A document that leaks its own markup still
// leaks only the hash.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import type { PanelConfig } from "./config.js";

export function newLoginState(): string {
  return randomBytes(24).toString("base64url");
}

export function loginStateHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Called on every GET of the login page and on every render that follows a
 *  refusal, so the form a merchant finally submits always carries a hash the
 *  browser still holds a cookie for. */
export function issueLoginState(c: Context, cfg: PanelConfig): string {
  const value = newLoginState();
  setCookie(c, cfg.loginStateCookieName, value, {
    httpOnly: true, secure: true, sameSite: "Lax", path: "/panel", maxAge: cfg.loginStateTtlSec,
  });
  return loginStateHash(value);
}

/** Constant-time on purpose: the comparison is over two 64-hex strings whose
 *  prefix an attacker can control the moment they can read one rendered form. */
export function checkLoginState(c: Context, cfg: PanelConfig, presented: string | undefined): boolean {
  const cookie = getCookie(c, cfg.loginStateCookieName);
  if (!cookie || !presented || !/^[0-9a-f]{64}$/.test(presented)) return false;
  const a = Buffer.from(loginStateHash(cookie), "hex");
  const b = Buffer.from(presented, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
