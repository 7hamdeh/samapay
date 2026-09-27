// COVERS: src/http/csp.ts  src/http/app.ts  src/render/panel-shell.ts
//
// RED-FIRST — CSP ON EVERY /panel AND /auth RESPONSE (pay-dashboard review
// 2026-09-27, "BEFORE PANEL_ENABLED=1: (1) CSP on /panel + /auth responses").
//
// WHY THIS IS A GO-LIVE BLOCKER AND NOT A LATER HARDENING STEP: /panel is the
// one place in this service that holds a session cookie a browser sends
// automatically, and the shell renders merchant-supplied strings (client names,
// key names) into HTML. Without a policy, one missed escape turns into a
// signed-in attacker minting keys and pointing webhooks at their own server —
// which is the HIGH this same review just closed, reached from the browser
// instead of from the API.
//
// WHY A HASH AND NOT 'unsafe-inline': the shell's script is inlined on purpose
// (see panel-shell.ts — a /panel.js would 404 on nginx's static root), so
// allowing inline scripts means allowing the injected one too. 'unsafe-inline'
// in script-src is the answer that makes the header decorative, and assertion 5
// below is the one that refuses it.
import crypto from "node:crypto";
process.env.SEED_ENCRYPTION_KEY = process.env.SEED_ENCRYPTION_KEY ?? crypto.randomBytes(32).toString("base64");
process.env.PANEL_ENABLED = "1";
process.env.MNTAD_SAMAPAY_HANDOFF_SECRET = "z".repeat(48);

import { assertSandboxDatabase } from "@/db/guard.js";
import { prisma } from "@/db/client.js";
import { check, summary, voidCheck } from "./lib/check.js";
import { readPanelConfig } from "@/panel/config.js";
import { FakeMailer } from "@/panel/mailer.js";
import { MemoryBucketStore } from "@/panel/rate-limit.js";
import { createSession } from "@/panel/session.js";

const RUN = Date.now().toString(36);
const BASE = "http://pay.mntad.test";

/** Reads one directive's full value out of a policy, e.g. directive("script-src")
 *  → `'sha256-abc='`. Written by hand rather than parsed by a library because the
 *  assertion is about WHAT THE BROWSER RECEIVES, and a parser that quietly
 *  tolerates a malformed header would hide exactly the bug this suite looks for. */
function directive(csp: string, name: string): string {
  return csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `) || d === name) ?? "";
}

async function main() {
  console.log(`database: ${await assertSandboxDatabase()}`);
  const cfg = readPanelConfig();
  check(cfg.enabled, "0a. SCAFFOLD — the panel is mounted for this run", `enabled=${cfg.enabled}`);

  const { buildApp } = await import("@/http/app.js");
  const { setPanelDeps } = await import("@/http/routes/panel/index.js");
  setPanelDeps({ cfg, buckets: new MemoryBucketStore(), mailer: new FakeMailer() });
  const app = buildApp();

  const account = await prisma.account.create({ data: { email: `csp-${RUN}@preview.invalid`, displayName: `CSP ${RUN}` } });
  let evilId = "";
  const session = await createSession({ accountId: account.id, via: "otp", ip: "203.0.113.7", userAgent: "verify-csp", cfg });
  const cookie = `${cfg.cookieName}=${session.token}; ${cfg.cookieName}_csrf=${session.csrfToken}`;
  const get = (path: string, headers: Record<string, string> = {}) =>
    app.request(`${BASE}${path}`, { headers: { cookie, ...headers } });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie, ...headers }, body: JSON.stringify(body) });

  try {
    // ── 1. EVERY /panel AND /auth RESPONSE CARRIES THE HEADER ──────────
    // "All responses" is the claim, so the sample is every SHAPE a response can
    // take, not just the happy one: an HTML 200, a JSON 200, a 401 from the
    // session gate, a 400 from body validation, a 404 from the router, and a
    // rate-limited 429. A middleware that returns early on one of them is a
    // merchant-facing page served with no policy.
    const html = await get("/panel/");
    const json = await get("/panel/account");
    const unauth = await get("/panel/keys?clientId=cli_x", { cookie: "" });
    const notFound = await get("/panel/no-such-view");
    const auth404 = await get("/auth/no-such-endpoint");
    const badBody = await post("/auth/code/request", {});
    const limited: string[] = [];
    let rate = 0;
    for (let i = 0; i < 40; i++) { const r = await post("/auth/verify", { email: `nope-${RUN}@preview.invalid`, purpose: "sign_in", code: "123456" }); if (r.status === 429) rate++; }
    const responses: Array<[string, number, string]> = [
      ["GET /panel/ (html 200)", html.status, html.headers.get("content-security-policy") ?? ""],
      ["GET /panel/account (json 200)", json.status, json.headers.get("content-security-policy") ?? ""],
      ["GET /panel/keys, no cookie (401)", unauth.status, unauth.headers.get("content-security-policy") ?? ""],
      ["GET /panel/no-such-view (404)", notFound.status, notFound.headers.get("content-security-policy") ?? ""],
      ["GET /auth/no-such-endpoint (404)", auth404.status, auth404.headers.get("content-security-policy") ?? ""],
      ["POST /auth/code/request, empty body (400)", badBody.status, badBody.headers.get("content-security-policy") ?? ""],
      [`POST /auth/verify, bucket exhausted (${rate}×429)`, rate > 0 ? 429 : 0, ""],
    ];
    const lastLimited = rate > 0 ? await post("/auth/verify", { email: `nope-${RUN}@preview.invalid`, purpose: "sign_in", code: "123456" }) : null;
    if (lastLimited) responses[6]![2] = lastLimited.headers.get("content-security-policy") ?? "";
    check(html.status === 200 && json.status === 200 && unauth.status === 401 && notFound.status === 404 && auth404.status === 404 && badBody.status === 400,
      "1a. SCAFFOLD — the sampled shapes are the statuses this suite means to header",
      [html.status, json.status, unauth.status, notFound.status, auth404.status, badBody.status, rate > 0 ? "429×" + rate : "no-429"].join(","));
    const missing = responses.filter(([, status, csp]) => status > 0 && csp === "").map(([label]) => label);
    check(missing.length === 0 && rate > 0, "1. every sampled /panel and /auth response — HTML, JSON, 401, 404, 400 and 429 — carries Content-Security-Policy",
      missing.length ? `missing on: ${missing.join("; ")}` : `${responses.length} response shapes, all headed${rate ? ` (${rate} requests rate-limited)` : ""}`);

    // ── 2. THE POLICY IS NOT DECORATIVE ────────────────────────────────
    const csp = html.headers.get("content-security-policy") ?? "";
    check(directive(csp, "default-src") === "default-src 'none'",
      "2a. default-src 'none' — everything the policy does not name is refused, so a new feature cannot inherit permission", directive(csp, "default-src"));
    check(!/\bwildcard\b/.test(csp) && !csp.includes(" *"), "2b. no `*` source anywhere in the policy", csp.slice(0, 120));
    check(directive(csp, "base-uri") === "base-uri 'none'",
      "2c. base-uri 'none' — a <base href> injected into the page is the classic way to redirect the shell's own relative fetches", directive(csp, "base-uri"));
    check(directive(csp, "frame-ancestors") === "frame-ancestors 'none'",
      "2d. frame-ancestors 'none' — the panel cannot be framed, so a clickjacked \"sign out\" or \"revoke key\" button is refused by the browser", directive(csp, "frame-ancestors"));
    check(directive(csp, "form-action") === "form-action 'none'",
      "2e. form-action 'none' — an injected <form> cannot POST a merchant's session cookie to another host", directive(csp, "form-action"));
    check(directive(csp, "connect-src") === "connect-src 'self'",
      "2f. connect-src 'self' — the shell's fetches stay on this origin, and an injected exfiltration fetch is blocked by the browser", directive(csp, "connect-src"));
    check(directive(csp, "style-src") === "style-src 'self'",
      "2g. style-src 'self' — /style.css loads, an injected <link> to an attacker's stylesheet does not", directive(csp, "style-src"));

    // ── 3. THE SHELL'S OWN SCRIPT IS AUTHORIZED BY ITS EXACT BYTES ─────
    const body = await html.text();
    const inlines = [...body.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    const hashes = inlines.map((s) => `'sha256-${crypto.createHash("sha256").update(s, "utf8").digest("base64")}'`);
    const scriptSrc = directive(csp, "script-src");
    check(inlines.length === 1, "3a. SCAFFOLD — the shell has exactly one inline script and no external one", `scripts=${inlines.length}`);
    const unauthorized = hashes.filter((h) => !scriptSrc.includes(h));
    check(unauthorized.length === 0 && hashes.length === 1,
      "3. the hash in script-src is the hash of the bytes this very response sent — a browser runs the dashboard's fetch layer",
      unauthorized.length ? `not authorized: ${unauthorized.join(",")}` : hashes.join(","));
    // The negative control that makes 3 worth having: the hash is over exact
    // content, so one changed byte — the mark of an injected payload sharing the
    // response — is no longer covered by the policy.
    const mutated = `'sha256-${crypto.createHash("sha256").update(inlines[0] + ";alert(1)", "utf8").digest("base64")}'`;
    check(mutated !== hashes[0] && !scriptSrc.includes(mutated),
      "3b. an added statement in that same script produces a DIFFERENT hash, which the policy does not carry — injected inline JS is blocked",
      `${mutated.slice(0, 22)}… ∉ script-src`);

    // ── 4. EVERYTHING THAT IS NOT THE SHELL GETS THE STRICTER DEFAULT ───
    const jsonCsp = json.headers.get("content-security-policy") ?? "";
    check(directive(jsonCsp, "script-src") === "script-src 'none'",
      "4. a JSON /panel response authorizes NO script at all — a page that renders there has nothing to run, and the HTML route must opt in explicitly to be able to run anything",
      directive(jsonCsp, "script-src") || "(absent)");
    const errCsp = (unauth.headers.get("content-security-policy") ?? "") + "|" + (badBody.headers.get("content-security-policy") ?? "");
    check(errCsp.includes("default-src 'none'") && errCsp.split("|").every((c) => directive(c, "script-src") === "script-src 'none'"),
      "4b. an error response is not a hole: same policy, no script source", errCsp.slice(0, 100));

    // ── 5. 'unsafe-inline' IS NOT THE ANSWER ANYWHERE ──────────────────
    const inlineInScript = responses.filter(([, status, c]) => status > 0 && directive(c, "script-src").includes("unsafe-inline"));
    check(inlineInScript.length === 0 && !csp.includes("unsafe-inline") && !csp.includes("unsafe-eval"),
      "5. no response puts 'unsafe-inline' or 'unsafe-eval' in script-src — either one re-opens exactly the injection this header exists to close",
      inlineInScript.map(([, , c]) => directive(c, "script-src")).join(" | ") || "clean");

    // ── 6. THE POLICY IS ONLY WHERE THE COOKIES ARE ────────────────────
    // Scoping claim, stated so silence is not approval: the header is added to
    // /panel and /auth, the two trees that carry the session cookie. /health and
    // /v1/* answer JSON to key-bearing machine clients and are deliberately
    // untouched by this change — asserted, because an unscoped middleware that
    // also headers /v1 would put a policy on the API's error responses and turn
    // a future docs/static page into a surprise.
    const health = await get("/health");
    const api = await get("/v1/deposits");
    const unknown = await get("/nope");
    check(health.headers.get("content-security-policy") === null && api.headers.get("content-security-policy") === null && unknown.headers.get("content-security-policy") === null,
      "6. /health, /v1/* and an unmatched top-level route carry NO CSP — the change is scoped to the cookie-bearing trees",
      `health=${health.status} api=${api.status} unknown=${unknown.status}`);

    // ── 7. BARE /panel (NO TRAILING SLASH) — THE nginx `location =` CASE ─
    // The go-live blocks have to cover it, and whether the app answers it at all
    // is a fact about Hono's routing, not an assumption to make in a config file.
    const bare = await get("/panel");
    const bareCsp = bare.headers.get("content-security-policy") ?? "";
    check([200, 301, 302, 404].includes(bare.status),
      `7. GET /panel with no trailing slash is answered (status ${bare.status})${bare.status === 200 ? " and headed" : " — nginx need not match it"}`,
      bare.status === 200 ? `csp=${bareCsp.includes("default-src 'none'")}` : `body=${(await bare.text()).slice(0, 40)}`);
    if (bare.status !== 200) voidCheck("7b. bare /panel carries the CSP", `the app answers it with ${bare.status}, so there is no response to header`);

    // ── 8. MERCHANT-SUPPLIED MARKUP CANNOT BREAK OUT OR ADD A SOURCE ────
    // The shell escapes client names (render/html.ts). What CSP adds on top is
    // that even an UNESCAPED injection could not load a script: the origin in
    // script-src is a hash, not 'self', so an attacker-controlled <script src>
    // — same origin or not — is refused. Proven here on the real render path by
    // putting markup in the display name and reading the bytes back.
    const evil = await prisma.account.create({ data: { email: `csp-evil-${RUN}@preview.invalid`, displayName: `</title><script src="/evil.js"></script>` } });
    evilId = evil.id;
    const evilSession = await createSession({ accountId: evil.id, via: "otp", ip: null, userAgent: null, cfg });
    const evilHtml = await get("/panel/", { cookie: `${cfg.cookieName}=${evilSession.token}` });
    const evilBody = await evilHtml.text();
    const evilCsp = evilHtml.headers.get("content-security-policy") ?? "";
    const evilInlines = [...evilBody.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    const evilHash = evilInlines.length === 1 ? `'sha256-${crypto.createHash("sha256").update(evilInlines[0]!, "utf8").digest("base64")}'` : "";
    check(evilHtml.status === 200 && evilBody.includes("&lt;/title&gt;&lt;script") && !evilBody.includes('<script src="/evil.js"'),
      "8a. the display name is escaped, so it never becomes a tag — the shell's own escaping is the first line and is asserted, not assumed",
      `escaped=${evilBody.includes("&lt;script")}`);
    check(evilHash !== "" && evilCsp.includes(evilHash) && !directive(evilCsp, "script-src").includes("'self'") && directive(evilCsp, "script-src").startsWith("script-src 'sha256-"),
      "8b. and even if escaping failed, script-src names a HASH and never 'self' — an injected <script src> has no source the browser will fetch",
      directive(evilCsp, "script-src").slice(0, 46));

    // ── 9. PANEL OFF: THE TREE HEADERS NOTHING, BECAUSE IT ANSWERS NOTHING ─
    // app.ts's own comment promises that with PANEL_ENABLED off "every /panel
    // and /auth path answers the same 404 as any unknown route, so a preview host
    // and a production host look identical from the outside". A CSP middleware
    // registered outside the panel's gate would break that sentence on its first
    // clause: one header on /panel/404 and none on /nope404 IS an announcement.
    const offCfg = readPanelConfig({} as never);
    setPanelDeps({ cfg: offCfg, buckets: new MemoryBucketStore(), mailer: new FakeMailer() });
    const offApp = buildApp();
    const offPanel = await offApp.request(`${BASE}/panel/`);
    const offAuth = await offApp.request(`${BASE}/auth/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const offOther = await offApp.request(`${BASE}/nope`);
    const errOf = async (r: Response) => JSON.stringify(((await r.json() as { error?: { code?: string; message?: string } }).error ?? {}).code ?? "?");
    check(offPanel.status === 404 && offAuth.status === 404 && offOther.status === 404
      && offPanel.headers.get("content-security-policy") === null
      && offAuth.headers.get("content-security-policy") === null
      && await errOf(offPanel) === await errOf(offOther),
      // Bodies are compared by code, not byte-for-byte: every error echoes a
      // unique X-Request-Id, so identical bytes would be an assertion about the
      // request id rather than about what a caller can tell the two paths apart.
      "9. with the panel OFF, /panel/ and /auth/ are the same 404 as any unknown route and carry no CSP — the header does not disclose the tree",
      `panel=${offPanel.status} auth=${offAuth.status} csp=${offPanel.headers.get("content-security-policy") === null ? "absent" : "PRESENT"}`);
  } finally {
    // Cleanup is by the ids this run created, never by an address pattern: a
    // `endsWith` sweep would delete other suites' accounts on a shared sandbox.
    const ids = [account.id, evilId].filter(Boolean);
    await prisma.panelSession.deleteMany({ where: { accountId: { in: ids } } });
    await prisma.account.deleteMany({ where: { id: { in: ids } } });
  }
  const failed = summary();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
