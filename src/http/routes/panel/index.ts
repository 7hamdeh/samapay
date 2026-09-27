// The merchant panel's routes. JSON on the API surface, one HTML shell at
// `/panel` that reads it, and NOTHING here that can move money: withdrawals are
// unmounted service-wide (src/http/app.ts:8-11) and no panel route reaches them.
//
// WHY ROUTES ARE THIS THIN: every decision — who may see which client, whether
// a code is spent, whether a key may be revoked, whether a webhook target is
// safe — lives in src/panel/*, where it can be tested without a server and
// where a second caller cannot miss it. A route here that "just does" its own
// prisma call would be the beginning of two answers to the same question.
import { Hono, type Context } from "hono";
import { readFileSync } from "node:fs";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { ApiError } from "../../errors.js";
import { cspHeader } from "../../csp.js";
import { logger } from "@/log.js";
import { clientIp } from "@/panel/request-ip.js";
import { isPlausibleEmail, normalizeEmail } from "@/panel/email.js";
import { enforce, MemoryBucketStore, type BucketStore } from "@/panel/rate-limit.js";
import { readPanelConfig, type PanelConfig } from "@/panel/config.js";
import { buildMailer, type Mailer } from "@/panel/mailer.js";
import { completeSignIn, requestCode, signOut } from "@/panel/auth.js";
import { checkLoginState, issueLoginState } from "@/panel/login-state.js";
import { consumeHandoff, newStateCookieValue, stateHashOf } from "@/panel/handoff-ticket.js";
import { checkCsrf, checkCsrfValue, clearSessionCookies, loadPrincipal, writeSessionCookies, type PanelPrincipal } from "@/panel/session.js";
import { getAccount, listMemberships } from "@/panel/accounts.js";
import { PANEL_MINTABLE_SCOPES, panelCreateKey, panelGetKey, panelListKeys, panelRevokeKey } from "@/panel/keys.js";
import { panelClearWebhook, panelListDeliveries, panelSetWebhook, panelTestWebhook } from "@/panel/webhook.js";
import { addressesView, auditView, balanceView, depositsView, intentsView } from "@/panel/read-views.js";
import { renderPanelShell } from "@/render/panel-shell.js";
import { renderLoginPage, type LoginError, type LoginView } from "@/render/panel-login.js";
import { PANEL_CSS } from "@/render/panel-css.js";

export interface PanelDeps {
  cfg: PanelConfig;
  buckets: BucketStore;
  mailer: Mailer;
}

// Built once at import; `setPanelDeps` exists so a verify script can swap in a
// fake mailer and a fresh bucket store without editing this file's behaviour.
const deps: PanelDeps = (() => {
  const cfg = readPanelConfig();
  return { cfg, buckets: new MemoryBucketStore(), mailer: buildMailer(cfg) };
})();

export function setPanelDeps(next: Partial<PanelDeps>): void {
  Object.assign(deps, next);
}
export function panelDeps(): PanelDeps {
  return deps;
}

const EMAIL = z.string().trim().min(3).max(320);
const PURPOSE = z.enum(["sign_up", "sign_in"]);
const CodeRequest = z.object({ email: EMAIL, purpose: PURPOSE, name: z.string().trim().max(120).optional() });
const VerifyBody = z.object({ email: EMAIL, purpose: PURPOSE, code: z.string().regex(/^[0-9]{6}$/), totp: z.string().max(10).optional() });
const ConsumeBody = z.object({ ticket: z.string().min(32).max(4096), state: z.string().min(16).max(256).optional() });
const MintBody = z.object({
  clientId: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  // The closed check lives in panelCreateKey (PANEL_MINTABLE_SCOPES), which is
  // where the "keys.issue is not mintable here" refusal has to be enforceable
  // even if a body arrives from somewhere other than this picker.
  scopes: z.array(z.string().min(3).max(40)).min(1),
  environment: z.enum(["live", "test"]).optional(),
  webhookUrl: z.string().url().max(500).optional(),
});
const RevokeBody = z.object({ reason: z.string().min(3).max(200) });
const WebhookBody = z.object({ url: z.string().url().max(500) });

async function parseBody<T>(c: Context, schema: z.ZodType<T>, hint: string): Promise<T> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError("invalid_input", hint, { issues: parsed.error.issues.map((i) => i.message) });
  return parsed.data;
}

function limited(c: Context, kind: Parameters<typeof enforce>[1], subject: string): void {
  const decision = enforce(deps.buckets, kind, subject);
  if (!decision.ok) throw new ApiError("rate_limited", "Too many requests for this action.", { retry_after_sec: decision.retryAfterSec });
}

async function requirePrincipal(c: Context): Promise<PanelPrincipal> {
  if (!deps.cfg.enabled) throw new ApiError("not_found", "The panel is not enabled on this service.");
  const principal = await loadPrincipal(c, deps.cfg);
  if (!principal) throw new ApiError("unauthenticated", "No panel session. Sign in with an emailed code or from your store.");
  return principal;
}

function requireCsrf(c: Context, principal: PanelPrincipal): void {
  if (!checkCsrf(c, deps.cfg, principal)) throw new ApiError("unauthenticated", "Missing or mismatched CSRF token.");
}

function requireOwner(membershipRole: string | null | undefined): void {
  if (membershipRole !== "owner") throw new ApiError("insufficient_scope", "This action belongs to the account owner, not a viewer.");
}

/** Panel refusal → the contract's error shape. `not_found` everywhere a
 *  tenancy question was answered "no", because confirming an id exists is the
 *  oracle panel-survey §5 refusal 5 refuses to open. */
function refuse(r: { code: string; reason?: string; scope?: string; allowance?: string; consumingWithdrawals?: number; createdVia?: string }): never {
  switch (r.code) {
    case "not_found": throw new ApiError("not_found", "No such resource for this account.");
    case "not_owner": throw new ApiError("insufficient_scope", "Your role on this account cannot do that.");
    case "scope_not_mintable": throw new ApiError("insufficient_scope", "This scope cannot be minted from the panel.", { scope: r.scope });
    case "target_refused": throw new ApiError("validation_failed", "That webhook target was refused.", { reason: r.reason });
    // R2/R3. 403, and the sentence says WHO can change it, because the person
    // reading this is a merchant who just clicked "edit" on their own key and
    // needs to know it is a rule of the platform rather than a broken button.
    case "webhook_locked": throw new ApiError("insufficient_scope", "This key's webhook is managed by the platform, not by the panel: it is the address the store is credited at.", { created_via: r.createdVia });
    // 409, and the contract's own conflict code: the merchant is not asking for
    // something invalid, they are asking for it while value sits behind the key.
    case "revoke_blocked": throw new ApiError("reference_conflict", "This key still holds value, so revoking it would strand it.", { allowance: r.allowance, consuming_withdrawals: r.consumingWithdrawals });
    default: throw new ApiError("internal", "Refusal mapping is incomplete.");
  }
}

export const auth = new Hono();

// ── email codes ────────────────────────────────────────────────────────────
// POST only. A code never appears in a URL, a query string or a redirect.
auth.post("/code/request", async (c) => {
  const body = await parseBody(c, CodeRequest, "Body must be { email, purpose, name? }.");
  const ip = clientIp(c);
  limited(c, "code_send", ip ?? "unknown");
  limited(c, "sign_in_request", body.email);
  const out = await requestCode({ email: body.email, purpose: body.purpose, ...(body.name ? { name: body.name } : {}) }, {
    cfg: deps.cfg, mailer: deps.mailer, ip, userAgent: c.req.header("user-agent") ?? null,
  });
  if (!out.ok) throw new ApiError("validation_failed", "That email address is not deliverable.");
  // The answer is the same whether or not an account exists for this address.
  return c.json({ sent: true, expires_in_sec: deps.cfg.codeTtlSec }, 202);
});

auth.post("/verify", async (c) => {
  const body = await parseBody(c, VerifyBody, "Body must be { email, purpose, code, totp? }.");
  const ip = clientIp(c);
  limited(c, "code_verify", body.email);
  const out = await completeSignIn({ email: body.email, purpose: body.purpose, code: body.code, totp: body.totp ?? null }, {
    cfg: deps.cfg, mailer: deps.mailer, ip, userAgent: c.req.header("user-agent") ?? null,
  });
  if (!out.ok) {
    if (out.code === "totp_required") throw new ApiError("unauthenticated", "This account requires its second factor.", { step: "totp" });
    if (out.code === "account_disabled") throw new ApiError("unauthenticated", "This account is disabled.");
    // invalid_code / no_such_account / email_invalid all answer identically:
    // "the code did not work". Nothing here says whether the address is ours.
    throw new ApiError("invalid_key", "That code did not work.");
  }
  writeSessionCookies(c, deps.cfg, out.token, out.csrfToken, out.expiresAt);
  return c.json({ signedIn: true, email: out.email, csrf_header: "X-CSRF-Token" }, 200);
});

auth.post("/signout", async (c) => {
  const principal = await loadPrincipal(c, deps.cfg);
  // Sign-out is CSRF-gated like every other mutation. Without it, any page on
  // the internet can log a merchant out — a nuisance today, and a way to mask
  // the "was this you?" signal (an attacker signs the owner out and the owner
  // blames their own session) the moment the panel grows notifications.
  if (principal) {
    requireCsrf(c, principal);
    await signOut({ accountId: principal.accountId, sessionId: principal.sessionId });
  }
  clearSessionCookies(c, deps.cfg);
  return c.json({ signedOut: true }, 200);
});

// ── the MNTAD handoff ──────────────────────────────────────────────────────
// A browser that already holds a stores.mntad.com session arrives here with a
// 60 s ticket. SamaPay ignores MNTAD's cookie entirely; it verifies the
// signature, the audience and the state hash, then SPENDS the ticket (see
// src/panel/handoff-ticket.ts for who owns the ledger and why).
auth.get("/handoff/state", (c) => {
  if (!deps.cfg.enabled) throw new ApiError("not_found", "The panel is not enabled on this service.");
  const value = newStateCookieValue();
  setCookie(c, deps.cfg.stateCookieName, value, {
    httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: deps.cfg.handoffTtlSec,
  });
  // The hash is what the issuer must put in the ticket; the value stays in the
  // browser's cookie jar and is never sent to MNTAD.
  return c.json({ stateHash: stateHashOf(value), ttl_sec: deps.cfg.handoffTtlSec }, 200);
});

auth.post("/handoff/consume", async (c) => {
  const body = await parseBody(c, ConsumeBody, "Body must be { ticket, state? }.");
  const ip = clientIp(c);
  limited(c, "handoff_consume", ip ?? "unknown");
  const stateCookie = getCookie(c, deps.cfg.stateCookieName) ?? body.state ?? null;
  const out = await consumeHandoff({
    signed: body.ticket, cfg: deps.cfg, stateCookie, ip, userAgent: c.req.header("user-agent") ?? null,
  });
  if (!out.ok) throw new ApiError("invalid_key", "That sign-in link did not work.", { code: out.code });
  writeSessionCookies(c, deps.cfg, out.token, out.csrfToken, out.expiresAt);
  clearState(c);
  return c.json({ signedIn: true, clientId: out.clientId, role: out.role }, 200);
});

function clearState(c: Context): void {
  setCookie(c, deps.cfg.stateCookieName, "", { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 0 });
}

// ── the panel itself ───────────────────────────────────────────────────────
const panel = new Hono();

import * as totpManagement from "@/panel/totp-management.js";

// ── the login page (HTML forms, no script, same CSP tree) ────────────────
// Why this is a page and not only an API: see src/render/panel-login.ts. Every
// decision below is the same one the JSON routes already make — the same
// `requestCode` / `completeSignIn`, the same buckets, the same session writer —
// so the browser front-end cannot drift from the API it sits on top of.
const FORM_FIELDS = ["email", "code", "totp", "lang", "login_state", "_csrf"] as const;
const langOf = (v: string | undefined): "en" | "ar" => (v === "ar" ? "ar" : "en");
const CODE_TTL_MIN = () => Math.round(deps.cfg.codeTtlSec / 60);

async function readForm(c: Context): Promise<Record<string, string>> {
  const parsed = await c.req.parseBody({ all: true }).catch(() => null);
  const out: Record<string, string> = {};
  if (!parsed) return out;
  for (const key of FORM_FIELDS) {
    const value = parsed[key];
    if (typeof value === "string") out[key] = value.slice(0, 400);
  }
  return out;
}

/** Every render issues a fresh state cookie and returns its hash, so the form
 *  the merchant submits always carries the hash of the cookie THIS response is
 *  setting. A state that outlived a refusal would be replayable. */
function loginHtml(c: Context, view: Omit<LoginView, "loginState">, status = 200): Response {
  const html = renderLoginPage({ ...view, loginState: issueLoginState(c, deps.cfg) });
  c.header("Content-Security-Policy", cspHeader());
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex");
  return c.html(html, status as 200);
}

panel.get("/login", (c) => loginHtml(c, { step: "email", lang: langOf(c.req.query("lang")), codeTtlMin: CODE_TTL_MIN() }));

panel.post("/login", async (c) => {
  const f = await readForm(c);
  const lang = langOf(f.lang);
  const email = normalizeEmail(f.email ?? "");
  const base = { step: "email" as const, lang, codeTtlMin: CODE_TTL_MIN(), ...(email ? { email } : {}) };
  // A state mismatch is a PROTOCOL failure, not a mistyped field: 400, so it can
  // be counted and alerted on, while the page still re-renders with the sentence.
  if (!checkLoginState(c, deps.cfg, f.login_state)) return loginHtml(c, { ...base, error: "state_expired" }, 400);
  if (!isPlausibleEmail(email)) return loginHtml(c, { ...base, error: "invalid_email" });

  const ip = clientIp(c);
  // Three buckets, three subjects, and the ORDER is the design: the 45 s spacing
  // answers first so a person who double-clicked "resend" is told how long to
  // wait rather than being told they are rate limited, and the two wider caps
  // still stop one address or one NAT from spending the MTA's day.
  const resend = enforce(deps.buckets, "code_resend", email);
  if (!resend.ok) return loginHtml(c, { step: "code", lang, email, codeTtlMin: CODE_TTL_MIN(), retryAfterSec: resend.retryAfterSec });
  if (!enforce(deps.buckets, "code_send", ip ?? "unknown").ok) return loginHtml(c, { ...base, error: "rate_limited" });
  if (!enforce(deps.buckets, "sign_in_request", email).ok) return loginHtml(c, { ...base, error: "rate_limited" });

  try {
    await requestCode({ email, purpose: "sign_up" }, { cfg: deps.cfg, mailer: deps.mailer, ip, userAgent: c.req.header("user-agent") ?? null });
  } catch (e) {
    // The mailer throwing means the MTA refused the message. A code row exists
    // and will expire unsent; what the merchant gets is the truth, not a page
    // that says "check your email".
    logger.warn({ err: e instanceof Error ? e.message : String(e), where: "panel.login.send" }, "login code could not be mailed");
    return loginHtml(c, { ...base, error: "mail_failed" });
  }
  return loginHtml(c, { step: "code", lang, email, codeTtlMin: CODE_TTL_MIN() });
});

panel.post("/login/code", async (c) => {
  const f = await readForm(c);
  const lang = langOf(f.lang);
  const email = normalizeEmail(f.email ?? "");
  const backToCode = (error: LoginError) => loginHtml(c, { step: "code", lang, email, codeTtlMin: CODE_TTL_MIN(), error });
  if (!checkLoginState(c, deps.cfg, f.login_state)) return loginHtml(c, { step: "email", lang, codeTtlMin: CODE_TTL_MIN(), error: "state_expired" }, 400);
  if (!isPlausibleEmail(email) || !/^[0-9]{6}$/.test(f.code ?? "")) return backToCode("bad_code");
  if (!enforce(deps.buckets, "code_verify", email).ok) return backToCode("rate_limited");
  const out = await completeSignIn({ email, purpose: "sign_up", code: f.code ?? "", totp: f.totp ?? null }, {
    cfg: deps.cfg, mailer: deps.mailer, ip: clientIp(c), userAgent: c.req.header("user-agent") ?? null,
  });
  if (!out.ok) {
    if (out.code === "totp_required") return backToCode("totp_required");
    if (out.code === "totp_invalid") return backToCode("totp_invalid");
    if (out.code === "account_disabled") return backToCode("account_disabled");
    // invalid_code / no_such_account / email_invalid answer identically, and the
    // page says what the API says: the code did not work. Whether the address is
    // ours is not in this response.
    return backToCode("bad_code");
  }
  writeSessionCookies(c, deps.cfg, out.token, out.csrfToken, out.expiresAt);
  // 303, not 200: the browser lands on /panel with a GET, so reloading the
  // destination cannot re-submit the code — a reload of a 200 would be a reload
  // of a spent credential.
  return c.redirect("/panel", 303);
});

panel.post("/logout", async (c) => {
  const f = await readForm(c);
  const principal = await loadPrincipal(c, deps.cfg);
  if (principal) {
    // A form cannot set X-CSRF-Token, so here the token travels in the body —
    // and ONLY here. checkCsrf, the API's, still reads the header and nothing
    // else; scripts/verify-panel-login.ts:6e is the assertion that keeps the two
    // from quietly becoming one check with two sources.
    if (!checkCsrfValue(principal, f._csrf)) throw new ApiError("unauthenticated", "Missing or mismatched CSRF token.");
    await signOut({ accountId: principal.accountId, sessionId: principal.sessionId });
  }
  clearSessionCookies(c, deps.cfg);
  return c.redirect("/panel/login", 303);
});

// ── the panel's own font files ───────────────────────────────────────────
// An ALLOWLIST of two names, not a path: `:file` is caller-supplied, and building
// a filesystem path out of a URL segment is how `/../../../.env` becomes a
// download. Anything outside the list is the same 404 as any unknown route.
const PANEL_FONTS: Record<string, string> = {
  "alexandria-latin.woff2": "font/woff2",
  "alexandria-arabic.woff2": "font/woff2",
};

panel.get("/fonts/:file", (c) => {
  const name = c.req.param("file") ?? "";
  const type = PANEL_FONTS[name];
  if (!type) throw new ApiError("not_found", "No such font.");
  const bytes = readFileSync(new URL(`../../../../public/panel/fonts/${name}`, import.meta.url));
  c.header("Content-Security-Policy", cspHeader());
  return c.body(new Uint8Array(bytes), 200, { "content-type": type, "cache-control": "public, max-age=31536000, immutable" });
});

panel.get("/panel.css", (c) => c.body(PANEL_CSS, 200, {
  // Same-origin, so `style-src 'self'` admits it. Public on purpose: a
  // stylesheet carries no merchant data, and refusing it to an expired session
  // would render the sign-in shell unstyled on the one page that must not look
  // broken. Short max-age because a deploy is the only thing that changes it.
  "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=300",
}));

/** The one HTML document the panel serves, and the one response that has to
 *  carry its OWN Content-Security-Policy: the app's default authorizes no script
 *  at all (src/http/csp.ts), so a shell rendered without this header is a page
 *  whose data never loads. The header is derived from the bytes about to be sent,
 *  by the renderer, so it cannot drift from the script it hashes. */
/** A browser sends an Accept of text/html; the shell's own fetches and every
 *  machine caller send the wildcard or application/json. Only the first is a
 *  person who should be looking at a login form — the rest keep the contract's
 *  401, so this change cannot move the API surface. */
function wantsHtml(c: Context): boolean {
  return /text\/html|application\/xhtml\+xml/.test(c.req.header("accept") ?? "");
}

export async function panelShell(c: Context): Promise<Response> {
  if (!deps.cfg.enabled) throw new ApiError("not_found", "The panel is not enabled on this service.");
  const principal = await loadPrincipal(c, deps.cfg);
  if (!principal) {
    if (wantsHtml(c)) return c.redirect("/panel/login", 302);
    throw new ApiError("unauthenticated", "No panel session. Sign in with an emailed code or from your store.");
  }
  const [account, clients] = await Promise.all([getAccount(principal.accountId), listMemberships(principal.accountId)]);
  const lang = c.req.query("lang") === "ar" ? "ar" : "en";
  const rendered = renderPanelShell({
    email: account?.email ?? principal.email, displayName: account?.displayName ?? null, clients,
    cfg: deps.cfg, csrfToken: principal.csrfToken, lang,
  });
  c.header("Content-Security-Policy", rendered.csp);
  return c.html(rendered.html, 200);
}

panel.get("/", panelShell);

panel.get("/account", async (c) => {
  const principal = await requirePrincipal(c);
  const [account, clients] = await Promise.all([getAccount(principal.accountId), listMemberships(principal.accountId)]);
  return c.json({
    account, clients,
    mintable_scopes: PANEL_MINTABLE_SCOPES,
    docs: { en: "/docs.html", ar: "/docs.ar.html", health: "/health" },
    session: { via: principal.via, expires_at: principal.expiresAt.toISOString() },
  }, 200);
});

panel.get("/keys", async (c) => {
  const principal = await requirePrincipal(c);
  const clientId = c.req.query("clientId");
  if (!clientId) throw new ApiError("invalid_input", "?clientId= is required and must be one of yours.");
  const rows = await panelListKeys(principal.accountId, clientId);
  if (rows === null) throw new ApiError("not_found", "No such client for this account.");
  return c.json({ keys: rows }, 200);
});

panel.post("/keys", async (c) => {
  const principal = await requirePrincipal(c);
  requireCsrf(c, principal);
  limited(c, "panel_mutation", principal.accountId);
  const body = await parseBody(c, MintBody, "Body must be { clientId, name, scopes[], environment?, webhookUrl? }.");
  const out = await panelCreateKey({
    accountId: principal.accountId, clientId: body.clientId, name: body.name, scopes: body.scopes,
    ...(body.environment ? { environment: body.environment } : {}),
    webhookUrl: body.webhookUrl ?? null, ip: clientIp(c), allowedHostnames: deps.cfg.webhookAllowedHostnames,
  });
  if (!out.ok) refuse(out);
  // The ONE response that carries the plaintext. There is no "show key again"
  // route, by construction: nothing else in this codebase ever returns it.
  return c.json({
    key: { id: out.id, prefix: out.row.keyPrefix, last4: out.row.keyLast4, scopes: out.row.scopes, environment: out.row.environment },
    plaintext: out.plaintext,
    webhook_secret: out.webhookSecret,
    warning: "This is the only time MNTAD Pay can show you this key. Store it now.",
  }, 201);
});

panel.post("/keys/:id/revoke", async (c) => {
  const principal = await requirePrincipal(c);
  requireCsrf(c, principal);
  limited(c, "panel_mutation", principal.accountId);
  const body = await parseBody(c, RevokeBody, "Body must be { reason }.");
  const out = await panelRevokeKey({ accountId: principal.accountId, keyId: c.req.param("id"), reason: body.reason });
  if (!out.ok) refuse(out);
  return c.json({ revoked: true }, 200);
});

panel.get("/keys/:id", async (c) => {
  const principal = await requirePrincipal(c);
  const row = await panelGetKey(principal.accountId, c.req.param("id"));
  if (!row) throw new ApiError("not_found", "No such key for this account.");
  return c.json({ key: row }, 200);
});

panel.post("/keys/:id/webhook", async (c) => {
  const principal = await requirePrincipal(c);
  requireCsrf(c, principal);
  limited(c, "panel_mutation", principal.accountId);
  const body = await parseBody(c, WebhookBody, "Body must be { url }.");
  const out = await panelSetWebhook({ accountId: principal.accountId, keyId: c.req.param("id"), url: body.url, allowedHostnames: deps.cfg.webhookAllowedHostnames });
  if (!out.ok) refuse(out);
  return c.json({ webhookUrl: out.webhookUrl, webhookSecret: out.webhookSecret, warning: "The secret is shown once. Every delivery to this URL is signed with it." }, 200);
});

panel.post("/keys/:id/webhook/clear", async (c) => {
  const principal = await requirePrincipal(c);
  requireCsrf(c, principal);
  limited(c, "panel_mutation", principal.accountId);
  const out = await panelClearWebhook({ accountId: principal.accountId, keyId: c.req.param("id") });
  if (!out.ok) refuse(out);
  return c.json({ cleared: true }, 200);
});

panel.post("/keys/:id/webhook/test", async (c) => {
  const principal = await requirePrincipal(c);
  requireCsrf(c, principal);
  // A test is a signed POST to a merchant-chosen address: it is the SSRF
  // amplifier if it is not throttled. One per minute per key, and the target is
  // re-guarded at send time inside panelTestWebhook.
  const limited_ = enforce(deps.buckets, "webhook_test", c.req.param("id"));
  if (!limited_.ok) throw new ApiError("rate_limited", "One test per key per minute.", { retry_after_sec: limited_.retryAfterSec });
  const out = await panelTestWebhook({ accountId: principal.accountId, keyId: c.req.param("id"), allowedHostnames: deps.cfg.webhookAllowedHostnames });
  if (!out.ok) refuse(out);
  return c.json({ deliveryId: out.deliveryId, status: out.status, outcome: out.outcome }, 200);
});

panel.get("/deliveries", async (c) => {
  const principal = await requirePrincipal(c);
  const clientId = requiredClient(c);
  const status = c.req.query("status");
  const rows = await panelListDeliveries({ accountId: principal.accountId, clientId, ...(status === undefined ? {} : { status }) });
  if (rows === null) throw new ApiError("not_found", "No such client for this account.");
  return c.json({ deliveries: rows }, 200);
});

panel.get("/balance", async (c) => {
  const principal = await requirePrincipal(c);
  const clientId = requiredClient(c);
  const out = await balanceView(principal.accountId, clientId);
  if ("code" in out) refuse(out);
  return c.json(out, 200);
});

panel.get("/deposits", async (c) => {
  const principal = await requirePrincipal(c);
  const clientId = requiredClient(c);
  const chain = c.req.query("chain");
  const reference = c.req.query("reference");
  const limit = c.req.query("limit");
  const out = await depositsView(principal.accountId, {
    clientId,
    ...(chain === "TRC20" || chain === "BEP20" ? { chain } : {}),
    ...(reference ? { reference } : {}),
    ...(limit === undefined ? {} : { limit: Number(limit) || 25 }),
  });
  if (out.code !== "ok") refuse({ code: out.code });
  return c.json({ deposits: out.rows?.map((d) => ({ ...d, reference: d.address?.reference ?? null, address: d.addressId })) }, 200);
});

panel.get("/intents", async (c) => {
  const principal = await requirePrincipal(c);
  const clientId = requiredClient(c);
  const status = c.req.query("status");
  const out = await intentsView(principal.accountId, { clientId, ...(status ? { status } : {}) });
  if (out.code !== "ok") refuse({ code: out.code });
  return c.json({ intents: out.rows }, 200);
});

panel.get("/addresses", async (c) => {
  const principal = await requirePrincipal(c);
  const clientId = requiredClient(c);
  const chain = c.req.query("chain");
  const referencePrefix = c.req.query("referencePrefix");
  const out = await addressesView(principal.accountId, {
    clientId,
    ...(chain === "TRC20" || chain === "BEP20" ? { chain } : {}),
    ...(referencePrefix ? { referencePrefix } : {}),
  });
  if (out.code !== "ok") refuse({ code: out.code });
  return c.json({ addresses: out.rows }, 200);
});

panel.get("/audit", async (c) => {
  const principal = await requirePrincipal(c);
  const clientId = requiredClient(c);
  const since = c.req.query("since");
  const out = await auditView(principal.accountId, { clientId, ...(since ? { since: new Date(since) } : {}) });
  if (out.code !== "ok") refuse({ code: out.code });
  return c.json({ events: out.rows }, 200);
});

panel.post("/2fa/enroll", async (c) => {
  const principal = await requirePrincipal(c);
  requireCsrf(c, principal);
  const created = await totpManagement.beginTotpEnrollment({ accountId: principal.accountId });
  return c.json(created, 200);
});

panel.post("/2fa/activate", async (c) => {
  const principal = await requirePrincipal(c);
  requireCsrf(c, principal);
  const body = await parseBody(c, z.object({ code: z.string().max(10) }), "Body must be { code }.");
  const activated = await totpManagement.activateTotp({ accountId: principal.accountId, sessionId: principal.sessionId, code: body.code });
  return c.json(activated, 200);
});

panel.post("/2fa/disable", async (c) => {
  const principal = await requirePrincipal(c);
  requireCsrf(c, principal);
  // The second factor itself, and a per-account budget on guessing it: this
  // request deletes the TOTP secret AND every backup code, so a session cookie
  // and a CSRF token — all a hijacked session holds — are not authorisation.
  // pay-dashboard review 2026-09-27, MEDIUM on item (2).
  limited(c, "second_factor", principal.accountId);
  const body = await parseBody(c, z.object({ code: z.string().trim().min(1).max(20) }), "Body must be { code } — the 6-digit code or a printed backup code.");
  const disabled = await totpManagement.disableTotp({ accountId: principal.accountId, code: body.code });
  return c.json(disabled, 200);
});

panel.get("/role", async (c) => {
  const principal = await requirePrincipal(c);
  return c.json({ clients: await listMemberships(principal.accountId) }, 200);
});

function requiredClient(c: Context): string {
  const clientId = c.req.query("clientId");
  if (!clientId) throw new ApiError("invalid_input", "?clientId= is required and must be one of yours.");
  return clientId;
}

export { panel };
export default panel;
