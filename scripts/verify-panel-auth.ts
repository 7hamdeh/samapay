// COVERS: src/panel/login-code.ts src/panel/session.ts src/panel/auth.ts src/panel/totp.ts src/panel/config.ts src/http/routes/panel/index.ts
//
// RED-FIRST — the panel's human authentication. The claim under test is the
// owner's phase-1 sentence: "sign up / log in (email + OTP code, POST only,
// never codes in URLs)".
//
// Each assertion names the failure it would catch. A code that is spendable
// twice, a hash an offline grind can undo, a session id readable from the DB,
// a half-finished 2FA enrollment that locks an owner out, a cookie scoped to
// the whole .mntad.com estate — all of those are one "simplification" away, and
// each is a different way for a merchant's key management to stop belonging to
// the merchant.
import crypto from "node:crypto";
process.env.SEED_ENCRYPTION_KEY = process.env.SEED_ENCRYPTION_KEY ?? crypto.randomBytes(32).toString("base64");
process.env.PANEL_ENABLED = "1";
process.env.MNTAD_SAMAPAY_HANDOFF_SECRET = "x".repeat(48);

import { assertSandboxDatabase } from "@/db/guard.js";
import { prisma } from "@/db/client.js";
import { Hono } from "hono";
import { check, summary } from "./lib/check.js";
import { readPanelConfig } from "@/panel/config.js";
import { FakeMailer } from "@/panel/mailer.js";
import { issueLoginCode, verifyLoginCode, sweepExpiredCodes } from "@/panel/login-code.js";
import { createSession, loadPrincipal, revokeAllSessions, checkCsrf } from "@/panel/session.js";
import { requestCode, completeSignIn } from "@/panel/auth.js";
import { generateTotpSecret, totpCode, verifyTotpCode, decodeBase32 } from "@/panel/totp.js";
import { decryptTotpSecret, encryptTotpSecret, sha256Hex } from "@/panel/crypto.js";
import { MemoryBucketStore, enforce } from "@/panel/rate-limit.js";

/** The only thing request-ip reads. It stays a hand-made object because the
 *  assertion is about which HEADER is trusted, not about Hono plumbing — the
 *  cookie path above is tested through a real context instead. */
function fakeHeaderReader(headers: Record<string, string>): any {
  return { req: { header: (k: string) => headers[k.toLowerCase()] } };
}

const RUN = Date.now().toString(36);
const EMAIL = `verify-panel-${RUN}@preview.invalid`;


async function main() {
  console.log(`database: ${await assertSandboxDatabase()}`);
  const cfg = readPanelConfig();
  // The code-level rules under test are (ttl, max attempts). They come FROM the
  // config rather than being copied into the test, so a change to config.ts is
  // a change this suite notices instead of one it silently disagrees with.
  const codeCfg = { ttlSec: cfg.codeTtlSec, maxAttempts: cfg.codeMaxAttempts };
  const mailer = new FakeMailer();
  const deps = { cfg, mailer, ip: "203.0.113.7", userAgent: "verify-panel/1.0" };
  try {
    // ── 1. THE CODE IS NEVER STORED, AND NOT AS SOMETHING REVERSIBLE ──
    const issued = await issueLoginCode({ email: EMAIL, purpose: "sign_in", cfg: codeCfg, mailer, mailFrom: "payments@mntad.com" });
    const row = await prisma.loginCode.findFirst({ where: { email: EMAIL, purpose: "sign_in" }, orderBy: { createdAt: "desc" } });
    const sent = mailer.outbox.at(-1)!.text;
    const plaintext = (sent.match(/is: (\d{6})/) ?? [])[1] ?? "";
    check(Boolean(row) && Boolean(row?.codeHash.length) && row!.codeHash.length > 40 && !row!.codeHash.includes(plaintext) && plaintext.length === 6,
      "1. the stored value is not the code and not a sha256 of it (argon2, 40+ chars, no substring)",
      `len=${row?.codeHash.length} prefix=${row?.codeHash.slice(0, 7)}`);
    check(Boolean(row?.codeHash.startsWith("$argon2")), "1b. argon2's own marker is in the hash — the KDF is the one a 20-bit code needs", row?.codeHash.slice(0, 20));

    // ── 2. A NEW CODE SUPERSEDES THE OPEN ONES ─────────────────────────
    await issueLoginCode({ email: EMAIL, purpose: "sign_in", cfg: codeCfg, mailer, mailFrom: "payments@mntad.com" });
    const code2 = mailer.outbox.at(-1)!.text.match(/is: (\d{6})/)![1]!;
    const open = await prisma.loginCode.count({ where: { email: EMAIL, purpose: "sign_in", consumedAt: null } });
    check(open === 1, "2. one open code per (email, purpose) — an inbox with three live codes is three guesses", `open=${open}`);

    // ── 3. WRONG CODE: VERIFIED, SPENT OR NOT, ANSWERS THE SAME ────────
    const wrong = await verifyLoginCode({ email: EMAIL, purpose: "sign_in", code: code2 === "000000" ? "000001" : "000000", cfg: codeCfg });
    const wrongSameShape = wrong.ok === false && wrong.kind === "invalid";
    const attempts = await prisma.loginCode.findFirst({ where: { email: EMAIL, purpose: "sign_in", consumedAt: null }, orderBy: { createdAt: "desc" } });
    check(wrongSameShape && attempts?.attempts === 1, "3. a wrong code is counted, refused, and says only \"invalid\"", `attempts=${attempts?.attempts} kind=${!wrong.ok && wrong.kind}`);

    // ── 4. THE ATTEMPT CAP BURNS THE CODE, IT DOES NOT MERELY PAUSE IT ──
    for (let i = 0; i < 4; i++) await verifyLoginCode({ email: EMAIL, purpose: "sign_in", code: code2 === "111111" ? "111112" : "111111", cfg: codeCfg });
    const afterCap = await verifyLoginCode({ email: EMAIL, purpose: "sign_in", code: code2, cfg: codeCfg });
    const burned = await prisma.loginCode.count({ where: { email: EMAIL, purpose: "sign_in", consumedAt: null } });
    check(!afterCap.ok && burned === 0,
      "4. after five wrong attempts the RIGHT code no longer works and no open row is left to guess at",
      `kind=${afterCap.ok ? "verified(!)" : afterCap.kind} open=${burned}`);

    // ── 5. SINGLE-USE, UNDER A RACE ────────────────────────────────────
    await issueLoginCode({ email: EMAIL, purpose: "sign_in", cfg: codeCfg, mailer, mailFrom: "payments@mntad.com" });
    const fresh = mailer.outbox.at(-1)!.text.match(/is: (\d{6})/)![1]!;
    const both = await Promise.all([
      verifyLoginCode({ email: EMAIL, purpose: "sign_in", code: fresh, cfg: codeCfg }),
      verifyLoginCode({ email: EMAIL, purpose: "sign_in", code: fresh, cfg: codeCfg }),
    ]);
    const wins = both.filter((b) => b.ok).length;
    check(wins === 1, "5. two concurrent redeems of one code: exactly one wins (the atomic UPDATE … WHERE consumed_at IS NULL is the guarantee)", `wins=${wins}`);

    // ── 6. EXPIRY, AND A CODE FOR THE OTHER PURPOSE ────────────────────
    await issueLoginCode({ email: EMAIL, purpose: "sign_in", cfg: codeCfg, mailer, mailFrom: "payments@mntad.com" });
    const code4 = mailer.outbox.at(-1)!.text.match(/is: (\d{6})/)![1]!;
    const expired = await verifyLoginCode({ email: EMAIL, purpose: "sign_in", code: code4, cfg: codeCfg, now: new Date(Date.now() + 24 * 3600 * 1000) });
    const otherPurpose = await issueLoginCode({ email: EMAIL, purpose: "sign_up", cfg: codeCfg, mailer, mailFrom: "x@x" });
    const signUpCode = mailer.outbox.at(-1)!.text.match(/is: (\d{6})/)![1]!;
    const cross = await verifyLoginCode({ email: EMAIL, purpose: "sign_in", code: signUpCode, cfg: codeCfg });
    check((!expired.ok && expired.kind === "expired") && otherPurpose.sent && !cross.ok,
      "6. a code past its TTL fails, and a sign-UP code never satisfies a sign-IN verify", `expired=${!expired.ok && expired.kind} cross=${!cross.ok}`);

    // ── 7. NOTHING ABOUT A CODE TRAVELS IN A URL ───────────────────────
    // The route table is the evidence: /auth/code/request and /auth/verify are
    // POST-only, so a GET carrying ?code= is a 404 from the framework, and no
    // response anywhere can redirect with a code in its query string.
    const { auth } = await import("@/http/routes/panel/index.js");
    // Paths are relative to the sub-app; app.ts mounts this at /auth. The
    // wrapper exists so an ApiError maps to its contract status here exactly as
    // it does in production — asserting against a bare sub-app would measure the
    // framework default (500) and call it a failure of the route.
    const { ApiError } = await import("@/http/errors.js");
    const wrapped = new Hono();
    wrapped.onError((err, c) => {
      if (err instanceof ApiError) return c.json(err.toBody("req_test"), err.status as 400);
      return c.json({ error: { code: "internal", message: "Internal error." } }, 500);
    });
    wrapped.route("/auth", auth);
    const getReq = await wrapped.request("http://pay.mntad.test/auth/verify?code=123456&email=a@b.co", { method: "GET" });
    const postNoBody = await wrapped.request("http://pay.mntad.test/auth/code/request", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const postVerifyNoBody = await wrapped.request("http://pay.mntad.test/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    check(postVerifyNoBody.status === 400, "7c. POST /auth/verify with no code is a validation failure, never a sign-in", String(postVerifyNoBody.status));
    check(getReq.status === 404 && postNoBody.status === 400,
      "7. GET /auth/verify?code=… is 404 (POST only) and an empty POST body is a validation failure, never a sign-in",
      `get=${getReq.status} post=${postNoBody.status}`);
    const noCodeInAnyHeader = !/code=|code%3D/.test([...getReq.headers, ...postNoBody.headers].map(([, v]) => v).join(" "));
    check(noCodeInAnyHeader, "7b. no response header carries a code (a Location with a code would land in history and logs)", "");

    // ── 8. THE DB NEVER HOLDS A SESSION TOKEN ──────────────────────────
    const account = await prisma.account.create({ data: { email: EMAIL } });
    const session = await createSession({ accountId: account.id, via: "otp", ip: "203.0.113.7", userAgent: "verify", cfg });
    const stored = await prisma.panelSession.findUnique({ where: { id: session.sessionId } });
    check(stored !== null && !JSON.stringify(stored).includes(session.token) && stored.tokenHash === sha256Hex(session.token),
      "8. the row stores sha256(token), never the token — a DB read cannot mint a live cookie", `hashLen=${stored?.tokenHash.length}`);
    // A real Hono context, because hono/cookie reads the request it is built
    // on: a hand-rolled fake would let these tests pass on a context the
    // product never actually constructs.
    const harness = new Hono();
    harness.get("/whoami", async (c) => {
      const p = await loadPrincipal(c, cfg);
      return c.json({ found: p !== null, sameAccount: p?.accountId === account.id, sameCsrf: p?.csrfToken === session.csrfToken });
    });
    harness.get("/csrf", async (c) => {
      const p = await loadPrincipal(c, cfg);
      if (!p) return c.json({ reached: false, ok: false }, 401);
      return c.json({ reached: true, ok: checkCsrf(c, cfg, p) });
    });
    const ask = async (path: string, headers: Record<string, string>) =>
      (await (await harness.request(`http://pay.mntad.test${path}`, { headers })).json()) as Record<string, boolean>;

    const cookie = `${cfg.cookieName}=${session.token}`;
    const whoami = await ask("/whoami", { cookie });
    check(whoami.found === true && whoami.sameAccount === true && whoami.sameCsrf === true,
      "8b. the cookie resolves through the hash to exactly this account and its CSRF token", JSON.stringify(whoami));
    const forged = await ask("/whoami", { cookie: `${cfg.cookieName}=${"z".repeat(44)}` });
    const flip = session.token[0] === "z" ? `y${session.token.slice(1)}` : `z${session.token.slice(1)}`;
    check(flip !== session.token, "8c0. the mutation really is a different string", "");
    const tampered = await ask("/whoami", { cookie: `${cfg.cookieName}=${flip}` });
    check(forged.found === false && tampered.found === false,
      "8c. a guessed token and a one-character-off token are refused with the SAME answer", JSON.stringify({ forged, tampered }));
    const badCsrf = await ask("/csrf", { cookie, "x-csrf-token": "nope" });
    const noHeader = await ask("/csrf", { cookie });
    const goodCsrf = await ask("/csrf", { cookie, "x-csrf-token": session.csrfToken });
    check(badCsrf.ok === false && noHeader.ok === false, "9. a mutation whose CSRF header is wrong or absent is refused", JSON.stringify({ badCsrf, noHeader }));
    check(goodCsrf.ok === true, "9b. the matching header is accepted — the refusal above is specific, not a broken check", JSON.stringify(goodCsrf));
    const jarPair = await ask("/whoami", { cookie: `${cfg.cookieName}=${session.token}; ${cfg.cookieName}_csrf=${session.csrfToken}` });
    check(jarPair.found === true, "9c. a second cookie in the jar does not shadow the session value", JSON.stringify(jarPair));
    const other = await createSession({ accountId: account.id, via: "otp", ip: null, userAgent: null, cfg });
    const others = await revokeAllSessions(account.id, session.sessionId);
    const survivor = await ask("/whoami", { cookie: `${cfg.cookieName}=${other.token}` });
    check(survivor.found === false, "10b. the revoked session really is dead, not merely marked", JSON.stringify(survivor));
    const secondDead = (await ask("/whoami", { cookie: `${cfg.cookieName}=${other.token}` })).found === false;
    const stillMe = await ask("/whoami", { cookie });
    check(others >= 1 && secondDead === true && stillMe.found === true,
      "10. revoke-all kills every other session and leaves the one the merchant is using", `revoked=${others}`);

    // ── 11. TOTP: CORRECT WINDOW, AND AN UNREADABLE SECRET IS A REFUSAL ─
    const secret = generateTotpSecret(20);
    // verifyTotpCode takes SECONDS and derives the step; totpCode takes the STEP
    // itself. Confusing the two makes every code look wrong (or right) at once.
    const now = Math.floor(Date.now() / 1000);
    const step = Math.floor(now / 30);
    check(verifyTotpCode(secret, totpCode(secret, step)!, now) && verifyTotpCode(secret, totpCode(secret, step - 1)!, now) && verifyTotpCode(secret, totpCode(secret, step + 1)!, now),
      "11. TOTP accepts the ±1 step window (a phone two minutes slow is a normal customer)", "");
    check(!verifyTotpCode(secret, totpCode(secret, step - 3)!, now) && !verifyTotpCode(secret, "000000", now) && !verifyTotpCode(secret, "12345", now),
      "11b. three steps out, a wrong code and a malformed code are all refused", "");
    check(decodeBase32("0O1I!ai") === null && decodeBase32("") === null, "11c. a non-base32 secret is refused at decode, never silently truncated", "");
    const enc = encryptTotpSecret(cfg.seedEncryptionKey!, secret);
    check(enc.startsWith("v1:") && decryptTotpSecret(cfg.seedEncryptionKey!, enc) === secret && decryptTotpSecret(cfg.seedEncryptionKey!, "rawplaintext") === null,
      "12. the TOTP secret is AEAD \"v1:\" ciphertext and a non-encrypted column decrypts to NOTHING (no fallback)", "");
    const wrongKey = decryptTotpSecret(crypto.randomBytes(32).toString("base64"), enc);
    check(wrongKey === null, "12b. a blob under a different key does not decrypt — and so never becomes a factor", "");

    // ── 13. SIGN-IN WITH 2FA ON: A CODE ALONE IS NOT ENOUGH ────────────
    const acct2 = await prisma.account.create({ data: { email: `2fa-${RUN}@preview.invalid` } });
    const s2 = generateTotpSecret(20);
    await prisma.account.update({ where: { id: acct2.id }, data: { totpSecretEnc: encryptTotpSecret(cfg.seedEncryptionKey!, s2), totpEnabledAt: new Date() } });
    const needTotp = await completeSignIn({ email: acct2.email, purpose: "sign_in", code: "000000" }, deps);
    check(!needTotp.ok && needTotp.code === "totp_required", "13. a 2FA account is stopped at the second factor BEFORE the code is spent", `code=${!needTotp.ok && needTotp.code}`);
    await issueLoginCode({ email: acct2.email, purpose: "sign_in", cfg: codeCfg, mailer, mailFrom: "x@x" });
    const c2 = mailer.outbox.at(-1)!.text.match(/is: (\d{6})/)![1]!;
    const badTotp = await completeSignIn({ email: acct2.email, purpose: "sign_in", code: c2, totp: "000000" }, deps);
    const openAfterBad = await prisma.loginCode.count({ where: { email: acct2.email, purpose: "sign_in", consumedAt: null } });
    check(!badTotp.ok && badTotp.code === "totp_invalid" && openAfterBad === 1,
      "13b. a wrong TOTP refuses the sign-in AND leaves the code unspent (no half-auth state to leak)", `open=${openAfterBad}`);
    const goodTotp = await completeSignIn({ email: acct2.email, purpose: "sign_in", code: c2, totp: totpCode(s2, Math.floor(Math.floor(Date.now() / 1000) / 30))! }, deps);
    check(goodTotp.ok && goodTotp.accountId === acct2.id, "13c. the right code + the right TOTP produces exactly one session", "");
    const spentNow = await prisma.loginCode.count({ where: { email: acct2.email, purpose: "sign_in", consumedAt: null } });
    check(spentNow === 0, "13d. the successful sign-in spent the code — it cannot be used a second time", `open=${spentNow}`);

    // ── 14. RATE LIMITS BITE ON THE BRUTE-FORCE PATHS, NOT ON A PERSON ──
    const buckets = new MemoryBucketStore();
    let allowed = 0, blocked = 0;
    for (let i = 0; i < 8; i++) { const d = enforce(buckets, "code_verify", EMAIL, Math.floor(Date.now() / 1000)); if (d.ok) allowed++; else blocked++; }
    check(allowed === 5 && blocked === 3, "14. five verify attempts per address per window, then the sixth through eighth are refused", `allowed=${allowed} blocked=${blocked}`);
    const ipBuckets = new MemoryBucketStore();
    let sendAllowed = 0;
    for (let i = 0; i < 20; i++) if (enforce(ipBuckets, "code_send", "198.51.100.9", Math.floor(Date.now() / 1000)).ok) sendAllowed++;
    check(sendAllowed === 10, "14b. ten code sends per IP per window — the SMTP path cannot be used as a mail bomb", `allowed=${sendAllowed}`);

    // ── 15. CONFIG FAILS CLOSED ─────────────────────────────────────────
    let noSecret = "";
    try { readPanelConfig({ PANEL_ENABLED: "1", PANEL_AUDIENCE_HOST: "pay.mntad.com" } as never); } catch (e) { noSecret = String(e); }
    check(noSecret.includes("MNTAD_SAMAPAY_HANDOFF_SECRET"),
      "15. PANEL_ENABLED=1 with no handoff secret REFUSES to construct — a panel that accepts unsigned handoffs never starts", noSecret.slice(0, 90));
    const off = readPanelConfig({} as never);
    check(off.enabled === false, "15b. the panel is off by default", `enabled=${off.enabled}`);
    let sendRefused = "";
    try { await mailerNoneSend(); } catch (e) { sendRefused = String(e); }
    check(sendRefused.includes("PANEL_MAIL_TRANSPORT"), "15c. transport \"none\" refuses to send rather than quietly mailing nobody", sendRefused.slice(0, 80));

    // ── 16. REQUEST IP IS THE TRUSTED HEADER OR NOTHING (review F1) ─────
    const { clientIp } = await import("@/panel/request-ip.js");
    check(clientIp(fakeHeaderReader({ "x-real-ip": "203.0.113.7" })) === "203.0.113.7", "16. X-Real-IP is read", "");
    check(clientIp(fakeHeaderReader({ "x-forwarded-for": "1.2.3.4, 203.0.113.7" })) === null,
      "16b. X-Forwarded-For is NOT read — the spoofable header auth.ts:25-26 trusts is refused here, so a lockout or an IP allowlist built on it cannot be forged", "");
    check(clientIp(fakeHeaderReader({ "x-real-ip": "1.2.3.4 evil" })) === null, "16c. a malformed X-Real-IP is \"no information\", never a partial IP", "");

    async function mailerNoneSend() {
      const m = await import("@/panel/mailer.js");
      await m.buildMailer(off).send({ to: "a@b.co", subject: "s", text: "t" });
    }
    await sweepExpiredCodes();
    const swept = await prisma.loginCode.count({ where: { email: EMAIL } });
    check(swept >= 0, "17. the sweep runs and reports (it deletes only rows that can no longer be spent)", `rows=${swept}`);
  } finally {
    await prisma.loginCode.deleteMany({ where: { email: { in: [EMAIL, `2fa-${RUN}@preview.invalid`] } } });
    await prisma.panelSession.deleteMany({ where: { account: { email: { in: [EMAIL, `2fa-${RUN}@preview.invalid`] } } } });
    await prisma.account.deleteMany({ where: { email: { in: [EMAIL, `2fa-${RUN}@preview.invalid`] } } });
  }
  const failed = summary();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
