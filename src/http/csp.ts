// The Content-Security-Policy for the two trees that carry a panel session
// cookie: /panel and /auth (pay-dashboard review 2026-09-27, go-live item 1).
//
// WHY A HASH AND NOT 'unsafe-inline': the shell's script is inlined on purpose
// (src/render/panel-shell.ts — a /panel.js would be served from nginx's static
// root, which is a deploy step the panel does not own), so any policy that
// allows inline scripts allows the injected one with it. 'unsafe-inline' would
// make this header decorative exactly where it matters: this is the one cookie
// in the service that can mint a key and point a webhook.
//
// WHY `script-src 'none'` IS THE DEFAULT AND THE PAGE OPTS IN: a route that
// starts returning HTML without asking for its own hash gets a broken page in
// front of a tester, not a silently weakened policy in front of a merchant.
import { createHash } from "node:crypto";

/** The CSP source expression for one inline script body, over its exact bytes. */
export function scriptHash(scriptBody: string): string {
  return `'sha256-${createHash("sha256").update(scriptBody, "utf8").digest("base64")}'`;
}

/**
 * `allowScripts` is the set of already-hashed inline scripts a response carries.
 * Empty (the default) is the JSON/error policy: no script runs anywhere.
 *
 * No `upgrade-insecure-requests`: it would rewrite the shell's own relative
 * /style.css fetch on any http origin, including the local run this policy has
 * to be testable on. HTTPS enforcement belongs where it already is — nginx's
 * `error_page 497` and the HSTS header on the vhost.
 */
export function cspHeader(allowScripts: readonly string[] = []): string {
  return [
    "default-src 'none'",
    allowScripts.length ? `script-src ${allowScripts.join(" ")}` : "script-src 'none'",
    "style-src 'self'",
    // Alexandria is served by this app from /panel/fonts/ (see src/render/panel-css.ts
    // for why the panel owns its stylesheet, and why the font has to come with it).
    // 'self' only — a login page that reaches fonts.gstatic.com at render time is a
    // privacy leak and a dependency on somebody else's uptime.
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    // 'self' because the login page IS a form posting to /panel/login. It is not
    // 'none' and not a host list: the one thing an injected <form> must never be
    // able to do is carry a session cookie to somebody else's address.
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** The trees the header is scoped to. `=== "/panel"` is not redundant with the
 *  prefix test: Hono answers the sub-app's "/" as the bare path (see app.ts). */
export function isCspScoped(path: string): boolean {
  return path === "/panel" || path.startsWith("/panel/") || path === "/auth" || path.startsWith("/auth/");
}
