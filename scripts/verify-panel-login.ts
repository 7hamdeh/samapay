// COVERS: src/render/panel-login.ts  src/http/routes/panel/index.ts (the /panel/login + /panel/logout form
//          routes and the browser-shaped redirect)  src/http/csp.ts  src/panel/rate-limit.ts (code_resend)
//          src/panel/session.ts (checkCsrfValue)  public/panel/fonts/*  src/http/app.ts (the font routes)
//
// RED-FIRST — THE LOGIN PAGE (owner's option (a), 2026-09-27).
//
// WHY THIS EXISTS: the 2026-09-27 browser pass found that the panel had no way
// for a HUMAN to sign in. `GET /panel` unauthenticated answered the 401 JSON of
// an API route; the only entry paths were `POST /auth/code/request` — which no
// browser calls, because nothing in the repo renders a form for it — and the
// MNTAD handoff, whose issuer is not built. Go-live check B5 ("the panel loads,
// the sign-up code arrives by mail") could not be performed by a person at all.
//
// WHAT THIS SUITE REFUSES, in order of how much it would cost to ship it:
//  · a page that needs JavaScript to log in — the whole flow must work as HTML
//    forms, so `script-src 'none'` stays on the login document (assertion 2).
//  · a credential in a URL — an email or a code in a query string lands in
//    nginx's access log, the browser history and any Referer header (assertion 4).
//  · login-CSRF: an attacker's page that completes ITS OWN account inside the
//    victim's browser, so the victim's next deposits are managed by somebody
//    else. The state cookie + hidden hash pair is the lock (assertion 7).
//  · a second source of truth for "is this a real account" — the answer must be
//    identical for an address that exists and one that does not (assertion 8).
//  · a resend button that mails on every click (assertion 9).
import crypto from "node:crypto";
process.env.SEED_ENCRYPTION_KEY = process.env.SEED_ENCRYPTION_KEY ?? crypto.randomBytes(32).toString("base64");
process.env.PANEL_ENABLED = "1";
process.env.MNTAD_SAMAPAY_HANDOFF_SECRET = "l".repeat(48);

import { assertSandboxDatabase } from "@/db/guard.js";
import { prisma } from "@/db/client.js";
import { check, summary } from "./lib/check.js";
import { readPanelConfig, type PanelConfig } from "@/panel/config.js";
import { FakeMailer } from "@/panel/mailer.js";
import { MemoryBucketStore, ruleFor, enforce } from "@/panel/rate-limit.js";
import { createSession } from "@/panel/session.js";

const RUN = Date.now().toString(36);
const BASE = "http://pay.mntad.com";
const EMAIL = `login-${RUN}@preview.invalid`;

const setCookiesOf = (r: Response): string[] => ((r.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [r.headers.get("set-cookie") ?? ""].filter(Boolean));
const cookieValue = (res: Response, name: string): string | null => {
  for (const line of setCookiesOf(res)) {
    const m = new RegExp(`^${name}=([^;]*)`).exec(line.trim());
    if (m) return m[1] ?? null;
  }
  return null;
};
const form = (rows: Record<string, string>) => new URLSearchParams(rows).toString();
/** The hidden field a browser would carry, read out of the rendered document. */
const fieldOf = (html: string, name: string): string => new RegExp(`name="${name}"[^>]*value="([^"]*)"`).exec(html)?.[1] ?? "";

async function main() {
  console.log(`database: ${await assertSandboxDatabase()}`);
  const cfg = readPanelConfig();
  const mailer = new FakeMailer();
  const buckets = new MemoryBucketStore();
  const { buildApp } = await import("@/http/app.js");
  const { setPanelDeps } = await import("@/http/routes/panel/index.js");
  setPanelDeps({ cfg, buckets, mailer });
  const app = buildApp();
  const get = (path: string, headers: Record<string, string> = {}) => app.request(`${BASE}${path}`, { headers });
  const post = (path: string, body: string, headers: Record<string, string> = {}) =>
    app.request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body });
  const HTML = { accept: "text/html,application/xhtml+xml" };

  try {
    // ── 1. THE PAGE EXISTS, AND IS A PAGE ───────────────────────────────
    const page = await get("/panel/login", HTML);
    const pageHtml = await page.text();
    check(page.status === 200 && (page.headers.get("content-type") ?? "").startsWith("text/html"),
      "1. GET /panel/login is a 200 HTML document, not the 401 JSON an API caller gets", `${page.status} ${page.headers.get("content-type")}`);
    check(/<form[^>]+method="post"/i.test(pageHtml) && /name="email"/.test(pageHtml),
      "1b. it carries a POST form with an email field — the flow is HTML, not a fetch()", "");
    check(page.headers.get("content-security-policy")?.includes("default-src 'none'") === true,
      "1c. the same CSP machinery covers it (it is under /panel/)", String(page.headers.get("content-security-policy")).slice(0, 40));

    // ── 2. NO SCRIPT ON THE LOGIN DOCUMENT ──────────────────────────────
    // The dashboard's shell has one hashed inline script; the login page must
    // have none. It is the most-visited and most-attacked surface of the panel,
    // it is served to anonymous browsers, and everything it has to do (type an
    // address, type a code) is a form. A page that needs no script cannot have
    // injected script run, and cannot be broken by a user with JS off.
    check(page.status === 200 && !/<script[\s>]/i.test(pageHtml), "2a. zero <script> on the login document (and the document really was served)", `matches=${(pageHtml.match(/<script/gi) ?? []).length}`);
    check(page.status === 200 && !/\son[a-z]+\s*=/i.test(pageHtml), "2b. zero inline event handlers (onclick=… is script with extra steps)", "");
    check(/script-src 'none'/.test(page.headers.get("content-security-policy") ?? ""),
      "2c. and the policy it is served under says 'none' — the page and the policy agree, so nothing is relying on a browser's tolerance",
      /script-src '[^']*'/.exec(page.headers.get("content-security-policy") ?? "")?.[0]);

    // ── 3. BILINGUAL, RTL FIRST ─────────────────────────────────────────
    const ar = await get("/panel/login?lang=ar", HTML);
    const arHtml = await ar.text();
    check(/<html[^>]+lang="ar"[^>]+dir="rtl"/.test(arHtml) && /<html[^>]+lang="en"[^>]+dir="ltr"/.test(pageHtml),
      "3a. ?lang=ar gives lang=ar dir=rtl, and the default is lang=en dir=ltr — on the document element, where CSS and screen readers look",
      `ar=${/<html[^>]+dir="rtl"/.test(arHtml)} en=${/<html[^>]+dir="ltr"/.test(pageHtml)}`);
    const arabicCopy = /[؀-ۿ]/.test(arHtml);
    const latinOnlyLabels = (h: string) => (h.match(/<label[^>]*>([^<]*)<\/label>/g) ?? []).filter((l) => !/[؀-ۿ]/.test(l));
    check(arabicCopy && latinOnlyLabels(arHtml).length === 0,
      "3b. every label on the Arabic page is Arabic — a half-translated login is a support ticket in another language",
      `labels=${(arHtml.match(/<label/g) ?? []).length} untranslated=${latinOnlyLabels(arHtml).length}`);
    check(/name="lang"[^>]*value="ar"|lang=ar/.test(arHtml),
      "3c. the language survives the POST (a merchant who chose Arabic does not get English back after a wrong code)",
      "");
    check(/<meta name="viewport" content="width=device-width/.test(pageHtml) && /<meta name="robots" content="noindex"/.test(pageHtml),
      "3d. mobile viewport declared, and noindex — a login page in a search result is a phishing target's starting point", "");

    // ── 4. NOTHING CREDENTIAL-SHAPED IN A URL ────────────────────────────
    const asked = await post("/panel/login", form({ email: EMAIL, lang: "en", login_state: fieldOf(pageHtml, "login_state") }), { cookie: stateCookieLine(page, cfg), ...HTML });
    const askedHtml = await asked.text();
    const actions = (askedHtml.match(/action="([^"]*)"/g) ?? []).map((a) => a.slice(9, -1));
    check(asked.status === 200 && /name="code"/.test(askedHtml),
      "4a. POST /panel/login with an address returns the code step (200), and a code row exists", `status=${asked.status}`);
    check(actions.length >= 1 && actions.every((a) => !a.includes("?") && !a.includes("#") && !a.includes(EMAIL) && !/\d{6}/.test(a)) && !setCookiesOf(asked).some((c) => /Location/i.test(c)),
      "4b. no form action carries a query, the address or six digits", actions.join(" "));
    const noLocation = asked.headers.get("location") === null;
    const headerLine = [...asked.headers].filter(([k]) => k.toLowerCase() !== "set-cookie").map(([k, v]) => `${k}:${v}`).join(" ");
    check(asked.status === 200 && noLocation && !/@|code=|\d{6}/.test(headerLine),
      "4c. no response header other than the cookies names an address or a code", headerLine.slice(0, 160));

    // ── 5. THE CODE SPENDS AND PRODUCES A SESSION ─────────────────────────
    const code = mailer.outbox.at(-1)?.text.match(/is: (\d{6})/)?.[1] ?? "";
    const state = fieldOf(askedHtml, "login_state");
    const verified = await post("/panel/login/code", form({ email: EMAIL, code, lang: "en", login_state: state }), { cookie: stateCookieLine(asked, cfg), ...HTML });
    const location = verified.headers.get("location") ?? "";
    check(verified.status === 303 && location === "/panel",
      "5a. the right code answers 303 → /panel (a redirect a browser follows with GET, and the only place it can point is the dashboard)",
      `${verified.status} ${location}`);
    const sessionCookie = cookieValue(verified, cfg.cookieName) ?? "";
    const csrfCookie = cookieValue(verified, `${cfg.cookieName}_csrf`) ?? "";
    const sessionLine = setCookiesOf(verified).find((c) => c.startsWith(`${cfg.cookieName}=`)) ?? "";
    check(sessionCookie.length > 30 && csrfCookie.length > 20 && /HttpOnly/i.test(sessionLine) && /Secure/i.test(sessionLine) && /SameSite=Lax/i.test(sessionLine) && /Path=\//.test(sessionLine) && !/Domain=/i.test(sessionLine),
      "5b. the session cookie is HttpOnly+Secure+SameSite=Lax and HOST-ONLY — no Domain= anywhere, because a cookie scoped to .mntad.com is readable by every other host on the estate",
      sessionLine.replace(sessionCookie, "«token»").slice(0, 96));
    check(!location.includes(code) && !location.includes(EMAIL) && !/spnl/.test(location),
      "5c. the redirect target carries neither the code nor the address", location);
    const dash = await get("/panel", { cookie: `${cfg.cookieName}=${sessionCookie}`, ...HTML });
    const dashHtml = await dash.text();
    check(dash.status === 200 && /^<!doctype html>/.test(dashHtml) && /data-view="keys"/.test(dashHtml),
      "5d. following that redirect with the cookies it set lands on the dashboard — a human being, end to end, through the browser's own rules",
      `status=${dash.status} html=${/^<!doctype html>/.test(dashHtml)}`);
    check(dash.headers.get("content-security-policy")?.includes("script-src 'sha256-") === true,
      "5e. and the dashboard is the hashed-script document, not the login one", /script-src [^;]*/.exec(dash.headers.get("content-security-policy") ?? "")?.[0]?.slice(0, 30));

    // ── 6. LOGOUT IS A FORM TOO, AND IT COSTS THE SESSION ─────────────────
    const csrfField = /name="_csrf"[^>]*value="([^"]*)"/.exec(dashHtml)?.[1] ?? fieldOf(dashHtml, "_csrf");
    check(csrfField.length > 10, "6a. SCAFFOLD — the dashboard's logout form carries the session's CSRF value", `len=${csrfField.length}`);
    const out = await post("/panel/logout", form({ _csrf: csrfField }), { cookie: `${cfg.cookieName}=${sessionCookie}; ${cfg.cookieName}_csrf=${csrfField}`, ...HTML });
    const cleared = setCookiesOf(out).filter((c) => /=;|=[^;]*;.*Max-Age=0|Expires=Thu, 01 Jan 1970/.test(c) || new RegExp(`^${cfg.cookieName}=;`).test(c.trim()));
    check(out.status === 303 && (out.headers.get("location") ?? "").startsWith("/panel/login") && cleared.length >= 1,
      "6b. POST /panel/logout clears the cookies and lands on the login page", `${out.status} ${out.headers.get("location")} cleared=${cleared.length}`);
    const afterOut = await get("/panel", { cookie: `${cfg.cookieName}=${sessionCookie}`, ...HTML });
    check(afterOut.status === 303 || afterOut.status === 302,
      "6c. and the dead session no longer reaches the dashboard — it is redirected to sign in", String(afterOut.status));
    const rowAfterOut = await prisma.panelSession.findFirst({ where: { tokenHash: crypto.createHash("sha256").update(sessionCookie).digest("hex") }, select: { revokedAt: true } });
    check(rowAfterOut !== null && rowAfterOut.revokedAt !== null, "6d. the SESSION ROW is revoked, not just the cookie forgotten (a stolen token replayed from elsewhere must die too)",
      `revokedAt=${String(rowAfterOut?.revokedAt)}`);
    // The API's CSRF contract is header-only. If the logout route taught
    // checkCsrf to read the body, /auth/signout would accept a form field too —
    // and a cross-origin form is exactly what SameSite=Lax was holding shut.
    // A LIVE session, not the one 6b just revoked: an expired session makes
    // /auth/signout answer 200 without ever consulting the token, and the
    // assertion would pass on a route that had no check at all.
    const liveSession = await createSession({ accountId: (await prisma.account.findUniqueOrThrow({ where: { email: EMAIL } })).id, via: "otp", ip: null, userAgent: null, cfg });
    const apiWithBodyToken = await app.request(`${BASE}/auth/signout`, { method: "POST", headers: { cookie: `${cfg.cookieName}=${liveSession.token}; ${cfg.cookieName}_csrf=${liveSession.csrfToken}`, "content-type": "application/x-www-form-urlencoded" }, body: form({ _csrf: liveSession.csrfToken }) });
    check(apiWithBodyToken.status === 401,
      "6e. the JSON API still refuses a body-borne CSRF token — the form path did not widen the API's contract", String(apiWithBodyToken.status));

    // ── 7. LOGIN-CSRF: THE STATE COOKIE IS THE OTHER HALF ────────────────
    const fresh = await get("/panel/login", HTML);
    const freshHtml = await fresh.text();
    const sentState = fieldOf(freshHtml, "login_state");
    const freshEmail = `csrf-${RUN}@preview.invalid`;
    const step2 = await post("/panel/login", form({ email: freshEmail, lang: "en", login_state: sentState }), { cookie: stateCookieLine(fresh, cfg), ...HTML });
    const step2Html = await step2.text();
    const realCode = mailer.outbox.at(-1)?.text.match(/is: (\d{6})/)?.[1] ?? "";
    check(step2.status === 200 && /name="code"/.test(step2Html) && realCode.length === 6, "7a. SCAFFOLD — a real two-step flow reached the code step", `code=${realCode ? "issued" : "absent"}`);
    check(stateCookieLine(step2, cfg) !== "", "7a2. SCAFFOLD — the state cookie is present to be withheld", stateCookieLine(step2, cfg).slice(0, 24));
    const noCookie = await post("/panel/login/code", form({ email: freshEmail, code: realCode, lang: "en", login_state: fieldOf(step2Html, "login_state") }), HTML);
    check(noCookie.status >= 400 && noCookie.status !== 404 && cookieValue(noCookie, cfg.cookieName) === null,
      "7b. THE LOCK (a 404 here is a missing route, not a refusal) — the right code with no state cookie is refused and sets no session (an attacker's page cannot complete its own account inside a victim's browser)",
      `${noCookie.status} session=${cookieValue(noCookie, cfg.cookieName) ? "SET" : "none"}`);
    const wrongState = await post("/panel/login/code", form({ email: freshEmail, code: realCode, lang: "en", login_state: "a".repeat(64) }), { cookie: stateCookieLine(step2, cfg) });
    check(wrongState.status >= 400 && wrongState.status !== 404 && cookieValue(wrongState, cfg.cookieName) === null,
      "7c. a state hash that does not match the cookie is refused on the same path, with the same answer", String(wrongState.status));
    const noField = await post("/panel/login/code", form({ email: freshEmail, code: realCode, lang: "en" }), { cookie: stateCookieLine(step2, cfg) });
    check(noField.status >= 400 && noField.status !== 404 && cookieValue(noField, cfg.cookieName) === null,
      "7d. and an ABSENT field is the same refusal — there is no branch where the check is skipped because nothing arrived", String(noField.status));
    // What a state refusal must NOT do: spend the code. The merchant who is
    // told "this sign-in expired" and types the code from the mail again would
    // otherwise be told, forever, that their own mail is wrong.
    const spendable = await post("/panel/login/code", form({ email: freshEmail, code: realCode, lang: "en", login_state: fieldOf(step2Html, "login_state") }), { cookie: stateCookieLine(step2, cfg), ...HTML });
    check(spendable.status === 303 && cookieValue(spendable, cfg.cookieName) !== null,
      "7e. CONTROL — after three state refusals the same code still signs in: a refusal at the state gate spends nothing",
      `${spendable.status} session=${cookieValue(spendable, cfg.cookieName) ? "set" : "none"}`);
    const replayed = await post("/panel/login/code", form({ email: freshEmail, code: realCode, lang: "en", login_state: fieldOf(step2Html, "login_state") }), { cookie: stateCookieLine(step2, cfg), ...HTML });
    const replayHtml = await replayed.text();
    check(replayed.status === 200 && cookieValue(replayed, cfg.cookieName) === null && /did not work|لا يعمل/i.test(replayHtml),
      "7f. and that code is single-use: the identical request a second later is refused with a sentence, not a session",
      `${replayed.status}`);

    // ── 8. THE ANSWER IS THE SAME FOR A STRANGER AND A MERCHANT ──────────
    // `freshEmail` already has an account (section 7 signed it in); the other
    // address has none. Both go through the identical request path.
    const shape = (h: string) => (h.match(/<input[^>]*name="([a-z_]+)"/g) ?? []).map((x) => /name="([a-z_]+)"/.exec(x)?.[1]).join(",");
    const knownPage = await get("/panel/login", HTML);
    const knownPageHtml = await knownPage.text();
    const existing = await post("/panel/login", form({ email: freshEmail, lang: "en", login_state: fieldOf(knownPageHtml, "login_state") }), { cookie: stateCookieLine(knownPage, cfg), ...HTML });
    const existingHtml = await existing.text();
    const neverPage = await get("/panel/login", HTML);
    const neverPageHtml = await neverPage.text();
    const never = await post("/panel/login", form({ email: `nobody-${RUN}@preview.invalid`, lang: "en", login_state: fieldOf(neverPageHtml, "login_state") }), { cookie: stateCookieLine(neverPage, cfg), ...HTML });
    const neverHtml = await never.text();
    check(existing.status === 200 && never.status === 200 && shape(existingHtml) === shape(neverHtml) && /name="code"/.test(existingHtml) && /name="code"/.test(neverHtml),
      "8. requesting a code for an address that already has an account and one that does not render the SAME fields — the login page is not an account-existence oracle",
      `${shape(existingHtml)} vs ${shape(neverHtml)}`);
    const acctCount = await prisma.account.count({ where: { email: `nobody-${RUN}@preview.invalid` } });
    check(acctCount === 1, "8b. and the upsert really did open the account the code will sign in to (this is the estate's own pattern: the login form IS registration)", `rows=${acctCount}`);

    // ── 9. RESEND HAS A COOLDOWN, AND THE PAGE SAYS HOW LONG ─────────────
    const resendEmail = `resend-${RUN}@preview.invalid`;
    const rc = await get("/panel/login", HTML);
    const rcHtml = await rc.text();
    const first = await post("/panel/login", form({ email: resendEmail, lang: "en", login_state: fieldOf(rcHtml, "login_state") }), { cookie: stateCookieLine(rc, cfg), ...HTML });
    await first.text();
    const before = mailer.outbox.length;
    const second = await post("/panel/login", form({ email: resendEmail, lang: "en", login_state: fieldOf(rcHtml, "login_state") }), { cookie: stateCookieLine(rc, cfg), ...HTML });
    const secondHtml = await second.text();
    const secs = /(\d+)\s*(?:second|ثانية|secs)/i.exec(secondHtml)?.[1] ?? "";
    check(second.status === 200 && mailer.outbox.length === before && Number(secs) > 0,
      "9a. a second request for the same address inside the cooldown sends NOTHING and says when the next one is allowed",
      `mails=${mailer.outbox.length - before} wait=${secs}`);
    const rule = ruleFor("code_resend");
    check(rule.capacity === 1 && rule.windowSec >= 15 && rule.windowSec <= 120,
      `9b. the cooldown is a named rule (${rule.capacity} per ${rule.windowSec}s per address), not a setTimeout in page script a merchant can click through`,
      `capacity=${rule.capacity} window=${rule.windowSec}`);
    // One store, three takes: the rule is per ADDRESS, so a second send to the
    // same address inside the window is refused with a bounded wait while a
    // different address is untouched. Two separate stores would prove nothing
    // about either, which is what this line asserted before.
    const oneStore = new MemoryBucketStore();
    const firstTake = enforce(oneStore, "code_resend", "addr-a", 1000);
    const secondTake = enforce(oneStore, "code_resend", "addr-a", 1000);
    const otherAddress = enforce(oneStore, "code_resend", "addr-b", 1000);
    const waitSec = secondTake.ok ? -1 : secondTake.retryAfterSec;
    check(firstTake.ok && !secondTake.ok && waitSec > 0 && waitSec <= ruleFor("code_resend").windowSec && otherAddress.ok,
      "9c. the cooldown is per ADDRESS: a second send to the same address is refused with a bounded wait, and another address is untouched",
      `first=${firstTake.ok} second=${secondTake.ok}/${waitSec}s other=${otherAddress.ok}`);

    // ── 10. ERRORS ARE CLEAR, LOCALIZED, AND NEVER LEAK A STACK ──────────
    // A VALID state cookie and field, so it is the email rule that answers and
    // not the state gate in front of it (the two refusals look different: 200
    // with a sentence about the address, versus 400 with a sentence about the
    // session — see 7b-7d).
    const badPage = await get("/panel/login", HTML);
    const badPageHtml = await badPage.text();
    const badEmail = await post("/panel/login", form({ email: "not-an-address", lang: "en", login_state: fieldOf(badPageHtml, "login_state") }), { cookie: stateCookieLine(badPage, cfg), ...HTML });
    const badEmailHtml = await badEmail.text();
    check(badEmail.status === 200 && /<form/i.test(badEmailHtml) && /email/i.test(badEmailHtml) && !/stack|prisma|z\.ZodError|invalid_input/i.test(badEmailHtml),
      "10a. a malformed address re-renders the form with a sentence about the address, not the validation library's output",
      `${badEmail.status}`);
    const badAr = await post("/panel/login", form({ email: "not-an-address", lang: "ar", login_state: fieldOf(badPageHtml, "login_state") }), { cookie: stateCookieLine(badPage, cfg), ...HTML });
    check(/[؀-ۿ]/.test(await badAr.text()), "10b. and the error is in the language the page was asked for", "");
    const badCode = await post("/panel/login/code", form({ email: freshEmail, code: "000001", lang: "en", login_state: fieldOf(step2Html, "login_state") }), { cookie: stateCookieLine(step2, cfg), ...HTML });
    const badCodeHtml = await badCode.text();
    check(badCode.status === 200 && !/session|signed in/i.test(badCodeHtml) && cookieValue(badCode, cfg.cookieName) === null,
      "10c. a wrong code is a form re-render with no session, and never a 500", String(badCode.status));
    const noBody = await post("/panel/login", "", HTML);
    check(noBody.status === 200 || noBody.status === 400, "10d. an empty POST body does not crash the route", String(noBody.status));
    const jsonPost = await app.request(`${BASE}/panel/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL }) });
    check([200, 400, 415].includes(jsonPost.status), "10e. a JSON body to the form route is handled, not a 500 (the form is urlencoded; the API is JSON — both must survive the other's shape)", String(jsonPost.status));

    // ── 11. BROWSER-SHAPED /panel REDIRECTS, API-SHAPED STILL 401s ─────────
    const browserPanel = await get("/panel", { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" });
    const apiPanel = await get("/panel", { accept: "application/json" });
    const fetchPanel = await get("/panel/account", { accept: "*/*" });
    check([302, 303].includes(browserPanel.status) && (browserPanel.headers.get("location") ?? "").startsWith("/panel/login"),
      "11a. a browser that is not signed in is taken TO the login page — this is the defect the pass found, and the fix asserted at the door",
      `${browserPanel.status} → ${browserPanel.headers.get("location")}`);
    check(apiPanel.status === 401 && (await apiPanel.json()).error?.code === "unauthenticated",
      "11b. a caller that asks for JSON still gets the contract's 401 — the redirect is for HTML, not a new API behaviour", String(apiPanel.status));
    check(fetchPanel.status === 401, "11c. the shell's own fetches (Accept: */*) get JSON errors, so a failed data view still renders its error text", String(fetchPanel.status));

    // ── 12. THE BRAND: SELF-HOSTED ALEXANDRIA, NO THIRD PARTY ────────────
    const css = await get("/panel/panel.css");
    const cssText = await css.text();
    const latin = await get("/panel/fonts/alexandria-latin.woff2");
    const latinBytes = Buffer.from(await latin.arrayBuffer());
    const arabic = await get("/panel/fonts/alexandria-arabic.woff2");
    const arabicBytes = Buffer.from(await arabic.arrayBuffer());
    check(latin.status === 200 && (latin.headers.get("content-type") ?? "").includes("font/woff2") && latinBytes.subarray(0, 4).toString("latin1") === "wOF2" && arabicBytes.subarray(0, 4).toString("latin1") === "wOF2",
      "12a. the Latin subset is served by the app as font/woff2 and is a real wOF2 file",
      `${latin.status} ${latin.headers.get("content-type")} ${latinBytes.length} B`);
    check(arabic.status === 200 && arabicBytes.length === 31348 && latinBytes.length === 30140,
      "12b. the two subsets are byte-for-byte the files stores.mntad.com ships (arabic 31,348 · latin 30,140, measured in samaprime's lib/fonts.ts) — same version, same glyphs, no second download of the same family",
      `arabic=${arabicBytes.length} latin=${latinBytes.length}`);
    const cssRules = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
    check(/@font-face/.test(cssRules) && /unicode-range/.test(cssRules) && /font-family:\s*['"]?Alexandria/.test(cssRules),
      "12c. the sheet declares the family per-subset with unicode-range, so a file is fetched only for a script the page actually renders",
      `@font-face=${(cssRules.match(/@font-face/g) ?? []).length}`);
    check(!/fonts\.googleapis\.com|fonts\.gstatic\.com|https?:\/\/(?!127\.0\.0\.1)[a-z0-9.-]+/i.test(cssRules + pageHtml),
      "12d. nothing reaches a third-party font host — no Google Fonts <link>, no gstatic URL. A login page that phones home to a CDN on every render is a privacy leak and a single point of failure",
      "");
    const csp = page.headers.get("content-security-policy") ?? "";
    check(/(^|; )font-src 'self'/.test(csp), "12e. font-src is 'self' — exactly wide enough for the files above, and asserted so it cannot quietly become a CDN host",
      /font-src [^;]*/.exec(csp)?.[0] ?? "(absent)");
    check(/form-action 'self'/.test(csp), "12f. form-action moved from 'none' to 'self' for the form flow — and only 'self', so an injected <form> still cannot post the session to another host",
      /form-action [^;]*/.exec(csp)?.[0] ?? "(absent)");
    // The route takes a FILENAME from the URL. Whether it then builds a path out
    // of it is the difference between a font host and a config-file reader, so
    // the climb is attempted, not assumed to be impossible.
    const climb = await get("/panel/fonts/" + encodeURIComponent("../../../../.env"));
    const climbBody = climb.status === 200 ? await climb.text() : "";
    // 404 specifically, not merely "not 200": a 500 from a path that escaped the
    // allowlist would satisfy `!== 200` while proving the guard is absent, and a
    // crash is also the answer a real traversal attempt should NOT produce.
    check(climb.status === 404 && !/DATABASE_URL|SEED_ENCRYPTION_KEY|PASSPHRASE/.test(climbBody),
      "12g. a font name written to climb out of public/ is a 404 — the same answer as any unknown route, not a crash and not the file",
      `${climb.status} body=${climbBody.slice(0, 24)}`);
    const nearMiss = await get("/panel/fonts/alexandria-latin.woff2.json");
    check(nearMiss.status === 404, "12h. the allowlist is an exact name, not a prefix — a suffixed lookalike is the same 404 as any unknown route", String(nearMiss.status));

    // ── 13. THE RATE LIMITS ARE THE API'S, NOT A NEW WEAKER SET ──────────
    const buckets2 = new MemoryBucketStore();
    setPanelDeps({ cfg, buckets: buckets2, mailer });
    const spamEmail = `spam-${RUN}@preview.invalid`;
    const mailsBefore = mailer.outbox.length;
    for (let i = 0; i < 12; i++) {
      const p = await get("/panel/login", HTML);
      const h = await p.text();
      const spam = await post("/panel/login", form({ email: spamEmail, lang: "en", login_state: fieldOf(h, "login_state") }), { cookie: stateCookieLine(p, cfg), ...HTML });
      await spam.text();
    }
    const rows = await prisma.loginCode.count({ where: { email: spamEmail } });
    const mails = mailer.outbox.length - mailsBefore;
    check(mails <= ruleFor("sign_in_request").capacity && rows <= ruleFor("sign_in_request").capacity && mails >= 1,
      `13. twelve send attempts for one address produce at most ${ruleFor("sign_in_request").capacity} codes — the page shares the buckets the JSON API does, so "resend" cannot be a mail bomb`,
      `mails=${mails} rows=${rows}`);
  } finally {
    const emails = [EMAIL, `csrf-${RUN}@preview.invalid`, `nobody-${RUN}@preview.invalid`, `resend-${RUN}@preview.invalid`, `spam-${RUN}@preview.invalid`];
    await prisma.auditEvent.deleteMany({ where: { actor: { in: emails.map((e) => `pending:${crypto.createHash("sha256").update(e).digest("hex").slice(0, 16)}`) } } });
    await prisma.panelSession.deleteMany({ where: { account: { email: { in: emails } } } });
    await prisma.loginCode.deleteMany({ where: { email: { in: emails } } });
    await prisma.accountClient.deleteMany({ where: { account: { email: { in: emails } } } });
    await prisma.account.deleteMany({ where: { email: { in: emails } } });
  }
  const failed = summary();
  process.exit(failed > 0 ? 1 : 0);
}

function stateCookieLine(res: Response, cfg: PanelConfig): string {
  const v = cookieValue(res, cfg.loginStateCookieName) ?? "";
  return v ? `${cfg.loginStateCookieName}=${v}` : "";
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
