// COVERS: src/panel/mailer.ts src/panel/config.ts src/panel/login-code.ts src/http/routes/panel/index.ts
//
// RED-FIRST — THE MAIL THAT ACTUALLY LEAVES THE PROCESS
// (pay-dashboard review 2026-09-27, go-live item 3: "PANEL_MAIL_TRANSPORT=sendmail
// + a real code delivered").
//
// WHY A SPAWNED SHIM AND NOT A FAKED MAILER: every other panel suite injects
// FakeMailer, which is the right call for testing a code's lifecycle — and it
// cannot see the transport at all. The header formatting, the argv, the exit
// status, the byte a stray \r\n costs: all of it lives in SendmailMailer, and
// nothing in the repo has ever run it. A login flow whose mail path has never
// executed is a login flow nobody has logged in through.
//
// WHAT "A REAL CODE IS DELIVERED" MEANS HERE: the bytes a merchant's mailbox
// receives are read back off disk, the six digits inside them are taken to
// POST /auth/verify, and the sign-in succeeds. The shim stands where postfix
// stands; every line between the app and it is the production code path.
// (The box's real /usr/sbin/sendmail is proven by scripts/prove-panel-mail-sendmail.ts,
// which is opt-in because it talks to a live MTA.)
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.SEED_ENCRYPTION_KEY = process.env.SEED_ENCRYPTION_KEY ?? crypto.randomBytes(32).toString("base64");
process.env.PANEL_ENABLED = "1";
process.env.MNTAD_SAMAPAY_HANDOFF_SECRET = "m".repeat(48);

import { assertSandboxDatabase } from "@/db/guard.js";
import { prisma } from "@/db/client.js";
import { check, summary } from "./lib/check.js";
import { readPanelConfig } from "@/panel/config.js";
import { buildMailer, loginCodeMail } from "@/panel/mailer.js";
import { MemoryBucketStore } from "@/panel/rate-limit.js";

const RUN = Date.now().toString(36);
const BASE = "http://pay.mntad.test";
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "samapay-mail-"));

/** Stands in for /usr/sbin/sendmail: records its argv, takes the message on
 *  stdin, exits on command. Written with the paths baked in because the only
 *  environment it inherits is the app's own. */
function shim(name: string, exitCode: number): string {
  const file = path.join(DIR, name);
  fs.writeFileSync(file, [
    "#!/bin/sh",
    `printf '%s\\n' "$@" > ${JSON.stringify(path.join(DIR, `${name}.argv`))}`,
    `cat > ${JSON.stringify(path.join(DIR, `${name}.msg`))}`,
    `echo "${name}: the MTA said no" >&2`,
    `exit ${exitCode}`,
    "",
  ].join("\n"), { mode: 0o700 });
  execFileSync("chmod", ["700", file]);
  return file;
}

const readMaybe = (p: string): string | null => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };

async function main() {
  console.log(`database: ${await assertSandboxDatabase()}`);
  const goodShim = shim("sendmail-ok", 0);
  const badShim = shim("sendmail-fails", 67);

  try {
    // ── 1. THE DEFAULTS A GO-LIVE HOST RELIES ON ────────────────────────
    const bare = readPanelConfig({ PANEL_ENABLED: "1", MNTAD_SAMAPAY_HANDOFF_SECRET: "q".repeat(40) } as never);
    check(bare.mailFrom === "noreply@mntad.com",
      "1. the default From is noreply@mntad.com — the address the box actually hosts a mailbox for, so a reply or a bounce has somewhere to go",
      bare.mailFrom);
    check(bare.mailTransport === "none",
      "1b. and the default transport is still \"none\": a host that forgets to say how it mails gets a refusal, not silence", bare.mailTransport);
    check(bare.sendmailPath === "/usr/sbin/sendmail" && fs.existsSync(bare.sendmailPath),
      "1c. the default path is the binary that exists on this box (postfix's sendmail)", bare.sendmailPath);

    const cfg = readPanelConfig({
      PANEL_ENABLED: "1", MNTAD_SAMAPAY_HANDOFF_SECRET: "q".repeat(40),
      PANEL_MAIL_TRANSPORT: "sendmail", PANEL_SENDMAIL_PATH: goodShim,
    } as never);
    check(cfg.mailTransport === "sendmail" && cfg.sendmailPath === goodShim,
      "2a. SCAFFOLD — PANEL_MAIL_TRANSPORT=sendmail with PANEL_SENDMAIL_PATH overridden for this run", `transport=${cfg.mailTransport}`);

    // ── 2. WHAT THE TRANSPORT PUTS ON THE WIRE ──────────────────────────
    const mailer = buildMailer(cfg);
    await mailer.send(loginCodeMail(cfg.mailFrom, `wire-${RUN}@preview.invalid`, "482913", 600));
    const argv = (readMaybe(`${goodShim}.argv`) ?? "").trim().split("\n");
    const msg = readMaybe(`${goodShim}.msg`) ?? "";
    check(fs.existsSync(`${goodShim}.argv`) && fs.existsSync(`${goodShim}.msg`),
      "2b. the send really spawned a process and piped a message into it — this is the transport, not a fake", argv.join(" "));
    check(argv.includes("-t") && argv.includes("-i"),
      "2c. -t (recipients from the headers) and -i (a lone dot in the body is not end-of-input)", argv.join(" "));
    check(argv.includes("-f") && argv.some((a, i) => a === "noreply@mntad.com" && argv[i - 1] === "-f"),
      "2d. THE ENVELOPE SENDER IS SET — `-f noreply@mntad.com`. Without it postfix MAIL-FOs from the unix account's own address, SPF is checked against THAT, and an aligned-looking From: header still fails: the mail lands in spam or not at all",
      argv.join(" "));
    const headers = msg.split(/\r?\n\r?\n/)[0] ?? "";
    const header = (name: string) => (new RegExp(`^${name}: (.+)$`, "im").exec(headers)?.[1] ?? "");
    check(header("From") === "noreply@mntad.com" && header("To") === `<wire-${RUN}@preview.invalid>`,
      "2e. From and To are on the wire, and the recipient is angle-bracketed so a display-name trick cannot extend it", `${header("From")} → ${header("To")}`);
    const decodedSubject = (() => {
      const m = /^=\?UTF-8\?B\?(.+)\?=$/.exec(header("Subject"));
      return m ? Buffer.from(m[1]!, "base64").toString("utf8") : header("Subject");
    })();
    check(header("Subject").startsWith("=?UTF-8?B?") && decodedSubject === "MNTAD Pay sign-in code · رمز دخول منطاد باي",
      "2f. the bilingual subject is an RFC 2047 encoded-word that decodes back to the same string — raw UTF-8 in a header is the receiver's guess, and one receiver's guess is mojibake in a merchant's inbox",
      decodedSubject.slice(0, 40));
    check(header("Content-Transfer-Encoding") === "8bit" && header("Auto-Submitted") === "auto-replied",
      "2f2. the body's encoding is DECLARED and the message is marked automated (RFC 3834), so an out-of-office responder does not answer a sign-in code",
      `${header("Content-Transfer-Encoding")}/${header("Auto-Submitted")}`);
    check(/^text\/plain; charset=utf-8$/.test(header("Content-Type")),
      "2g. utf-8 is declared, or the Arabic half of the body arrives as mojibake to a client that guessed", header("Content-Type"));
    check(/^<[^@\s]+@mntad\.com>$/.test(header("Message-ID")),
      "2h. a Message-ID in the sender's own domain — postfix does not add one for a local submission, and several receivers reject a message with none",
      header("Message-ID"));
    check(header("MIME-Version") === "1.0", "2h2. MIME-Version is present, since Content-Type is a MIME header", header("MIME-Version"));
    const ageSec = Math.abs(Date.now() - Date.parse(header("Date"))) / 1000;
    check(ageSec < 120 && /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} (?:[+-]\d{4}|GMT)$/.test(header("Date")),
      "2i. an RFC 2822 Date generated NOW, so the code's TTL is the same minute on both sides of the delivery", `${header("Date")} (${ageSec.toFixed(0)}s off)`);
    const body = msg.slice(headers.length);
    check(body.includes("482913") && msg.split("482913").length - 1 === 2,
      "2j. the code appears once in the English half and once in the Arabic half, and nowhere in the headers",
      `occurrences=${msg.split("482913").length - 1}`);
    check(body.includes("رمز الدخول") && body.includes("sign-in code"), "2k. both languages are in the same message", "");
    check(/\r\n/.test(headers) && !/\r?\n[ \t]*\r?\n/.test(headers), "2l. headers are CRLF-terminated with exactly one blank line before the body", "");

    // ── 3. A REAL CODE, DELIVERED, SPENDS AT /auth/verify ───────────────
    const { buildApp } = await import("@/http/app.js");
    const { setPanelDeps } = await import("@/http/routes/panel/index.js");
    setPanelDeps({ cfg, buckets: new MemoryBucketStore(), mailer: buildMailer(cfg) });
    const app = buildApp();
    const email = `delivered-${RUN}@preview.invalid`;
    const asked = await app.request(`${BASE}/auth/code/request`, {
      method: "POST", headers: { "content-type": "application/json", "x-real-ip": "203.0.113.7" },
      body: JSON.stringify({ email, purpose: "sign_up", name: "Delivered Test" }),
    });
    const delivered = readMaybe(`${goodShim}.msg`) ?? "";
    const code = (delivered.match(/is: (\d{6})/) ?? [])[1] ?? "";
    check(asked.status === 202 && /^\d{6}$/.test(code),
      "3a. POST /auth/code/request answers 202 and a message containing a six-digit code reaches the MTA", `status=${asked.status} code=${code ? "present" : "absent"}`);
    const row = await prisma.loginCode.findFirst({ where: { email }, orderBy: { createdAt: "desc" } });
    const { verifySecret } = await import("@/panel/crypto.js");
    check(Boolean(row) && code !== "" && await verifySecret(row!.codeHash, code),
      "3b. the code IN THE DELIVERED MESSAGE is the one the row's argon2 hash accepts — the mail is the credential, not a copy of something else",
      `hash=${row?.codeHash.slice(0, 9)}`);
    // The two clocks are allowed a named, ONE-DIRECTIONAL disagreement.
    // issueLoginCode takes `now` before the argon2 hash and the two writes, so
    // the row's window is measured from a moment earlier than the row's own
    // created_at: the code can live a little LESS than the mail promises, never
    // more. An assertion demanding exact equality would be a flake that hides
    // the one direction worth failing on — a row outliving its quoted TTL.
    const rowTtlMs = row ? row.expiresAt.getTime() - row.createdAt.getTime() : NaN;
    const shortByMs = cfg.codeTtlSec * 1000 - rowTtlMs;
    check(Boolean(row) && shortByMs >= -500 && shortByMs < 5000 && delivered.includes(`${Math.round(cfg.codeTtlSec / 60)} minutes`),
      "3c. the TTL the mail quotes is the TTL the row carries, and the row is never LONGER than the promise",
      `ttl=${cfg.codeTtlSec}s, row short by ${shortByMs.toFixed(0)}ms (that is the argon2 hash + two writes)`);
    const spent = await app.request(`${BASE}/auth/verify`, {
      method: "POST", headers: { "content-type": "application/json", "x-real-ip": "203.0.113.7" },
      body: JSON.stringify({ email, purpose: "sign_up", code }),
    });
    const setCookie = spent.headers.get("set-cookie") ?? "";
    check(spent.status === 200 && setCookie.includes(cfg.cookieName),
      "3d. THE CLAIM, END TO END — signing in with only what arrived by mail produces a session cookie",
      `status=${spent.status} cookie=${setCookie.includes("HttpOnly") ? "httponly" : "NOT httponly"}`);
    const replay = await app.request(`${BASE}/auth/verify`, {
      method: "POST", headers: { "content-type": "application/json", "x-real-ip": "203.0.113.7" },
      body: JSON.stringify({ email, purpose: "sign_up", code }),
    });
    check(replay.status !== 200, "3e. the delivered code spends once; a second use of the same mail is refused", String(replay.status));

    // ── 4. THE MERCHANT IS NEVER TOLD "SENT" BY A TRANSPORT THAT FAILED ──
    const failCfg = readPanelConfig({
      PANEL_ENABLED: "1", MNTAD_SAMAPAY_HANDOFF_SECRET: "q".repeat(40),
      PANEL_MAIL_TRANSPORT: "sendmail", PANEL_SENDMAIL_PATH: badShim,
    } as never);
    setPanelDeps({ cfg: failCfg, buckets: new MemoryBucketStore(), mailer: buildMailer(failCfg) });
    const downApp = buildApp();
    const downcast = await downApp.request(`${BASE}/auth/code/request`, {
      method: "POST", headers: { "content-type": "application/json", "x-real-ip": "198.51.100.9" },
      body: JSON.stringify({ email: `mta-down-${RUN}@preview.invalid`, purpose: "sign_up" }),
    });
    const downBody = await downcast.text();
    check(downcast.status >= 500 && !downBody.includes('"sent":true'),
      "4a. an MTA that exits non-zero is NOT answered with {sent:true} — a merchant who is told \"check your email\" and gets nothing is a support ticket that ends with a password reset they cannot do",
      `status=${downcast.status} body=${downBody.slice(0, 60)}`);

    // The misconfiguration case the review named (§3.5): transport "none" is the
    // repo default, so a production host that never sets PANEL_MAIL_TRANSPORT
    // must fail LOUDLY at the first sign-up, not mail nobody and say it sent.
    const noneCfg = readPanelConfig({ PANEL_ENABLED: "1", MNTAD_SAMAPAY_HANDOFF_SECRET: "q".repeat(40) } as never);
    setPanelDeps({ cfg: noneCfg, buckets: new MemoryBucketStore(), mailer: buildMailer(noneCfg) });
    const noneApp = buildApp();
    const noneRes = await noneApp.request(`${BASE}/auth/code/request`, {
      method: "POST", headers: { "content-type": "application/json", "x-real-ip": "198.51.100.10" },
      body: JSON.stringify({ email: `unconfigured-${RUN}@preview.invalid`, purpose: "sign_up" }),
    });
    const noneBody = await noneRes.text();
    check(noneRes.status >= 500 && !noneBody.includes('"sent":true') && !/PANEL_MAIL_TRANSPORT/.test(noneBody),
      "4b. with the default transport \"none\" the request fails, and the operator's log — not the merchant's response — is where the missing variable is named",
      `status=${noneRes.status} leaks=${/PANEL_MAIL_TRANSPORT/.test(noneBody)}`);

    // ── 5. NOTHING MERCHANT-SUPPLIED BECOMES A HEADER ───────────────────
    const beforeMsg = readMaybe(`${goodShim}.msg`) ?? "";
    const injected = await app.request(`${BASE}/auth/code/request`, {
      method: "POST", headers: { "content-type": "application/json", "x-real-ip": "198.51.100.11" },
      body: JSON.stringify({ email: `a@b.co\r\nBcc: victim@example.invalid`, purpose: "sign_up" }),
    });
    const afterMsg = readMaybe(`${goodShim}.msg`) ?? "";
    check(injected.status === 400 && beforeMsg === afterMsg,
      "5a. an address carrying CRLF is refused at validation, and nothing reaches the transport at all — no extra Bcc: header",
      `status=${injected.status} message unchanged=${beforeMsg === afterMsg}`);
    const longCode = await prisma.loginCode.count({ where: { email: { startsWith: "a@b.co" } } });
    check(longCode === 0, "5b. and the refused request wrote no code row either", `rows=${longCode}`);
  } finally {
    // Cleanup names the addresses THIS run wrote, never a domain-wide sweep: a
    // shared samapay_sandbox holds other suites' rows and is not ours to empty.
    const emails = [
      `wire-${RUN}@preview.invalid`, `delivered-${RUN}@preview.invalid`,
      `mta-down-${RUN}@preview.invalid`, `unconfigured-${RUN}@preview.invalid`, "a@b.co",
    ];
    await prisma.panelSession.deleteMany({ where: { account: { email: { in: emails } } } });
    await prisma.loginCode.deleteMany({ where: { email: { in: emails } } });
    await prisma.account.deleteMany({ where: { email: { in: emails } } });
    fs.rmSync(DIR, { recursive: true, force: true });
  }
  const failed = summary();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
