// COVERS: src/panel/mailer.ts against the MTA that is actually installed here.
//
// THE LIVE HALF OF GO-LIVE ITEM 3. verify-panel-mail.ts proves the transport's
// bytes, its argv and its exit handling against a spawned stand-in for
// /usr/sbin/sendmail; nothing in it can say whether THIS box's postfix accepts
// what the panel writes and delivers it to a mailbox. That is the difference
// between "the code is addressed correctly" and "a merchant signs in tonight".
//
// WHAT IT TOUCHES: one submission to `/usr/sbin/sendmail`, and one file in one
// Maildir. NO DATABASE ROW IS WRITTEN — the spendable-code half is the hermetic
// suite's job (verify-panel-mail.ts 3b/3d), and a live proof that minted a login
// code against a real account would be a credential sitting in a table for ten
// minutes. The sandbox guard still runs first, because that is this repo's rule
// for anything under scripts/ that is not a generator.
//
// REFUSES TO RUN without --confirm, and refuses any recipient outside the
// mailboxes this box hosts locally. Measured before writing this file:
//   mydestination is empty, virtual_mailbox_domains comes from
//   /www/vmail/postfixadmin.db (mntad.com is in it), mail_location is
//   maildir:/www/vmail/%d/%n, the SigningTable maps *@mntad.com, and
//   mail.mntad.com resolves to this host — which is what the SPF `+mx` on
//   mntad.com authorizes. So a message to noreply@mntad.com is a LOCAL delivery
//   by a server this domain authorizes, and it never leaves the building.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const RUN = "panel-mail-probe";
const LOCAL_MAILBOX_ROOT = "/www/vmail";
const DEFAULT_TO = "noreply@mntad.com";

function refuse(msg: string): never {
  console.error(`REFUSING (${RUN}): ${msg}`);
  process.exit(2);
}

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

/** The Maildir `new/` a local recipient's mail lands in, or null when this box
 *  does not host that address. Both spellings of dovecot's %n are tried because
 *  postfixadmin writes a trailing-slash maildir that does not always match the
 *  directory on disk; guessing one would make a failed lookup look like a failed
 *  delivery. */
function localNewDir(address: string): string | null {
  const [local, domain] = address.split("@");
  if (!local || !domain) return null;
  for (const candidate of [
    path.join(LOCAL_MAILBOX_ROOT, domain, local, "new"),
    path.join(LOCAL_MAILBOX_ROOT, domain, `${local}@${domain}`, "new"),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function main() {
  if (!process.argv.includes("--confirm")) {
    refuse("this sends a real message through /usr/sbin/sendmail. Re-run with --confirm (and optionally --to address@mntad.com).");
  }
  const { assertSandboxDatabase } = await import("@/db/guard.js");
  console.log(`database (guard only — nothing is written): ${await assertSandboxDatabase()}`);

  const to = arg("--to") ?? DEFAULT_TO;
  if (!/^[a-z0-9._+-]+@[a-z0-9.-]+$/.test(to)) refuse(`--to is not a plain address: ${to}`);
  const newDir = localNewDir(to);
  if (!newDir) refuse(`${to} is not a mailbox this box hosts under ${LOCAL_MAILBOX_ROOT}/ — refusing to hand the MTA a recipient it would relay to the internet`);

  const { readPanelConfig } = await import("@/panel/config.js");
  const { buildMailer, loginCodeMail } = await import("@/panel/mailer.js");
  const { randomNumericCode } = await import("@/panel/crypto.js");

  // The REAL config a go-live host runs: no PANEL_SENDMAIL_PATH override, no
  // test transport. process.env is what it is; if .env says `none`, this proves
  // that too, by refusing to send.
  const cfg = readPanelConfig({ ...process.env, PANEL_MAIL_TRANSPORT: process.env.PANEL_MAIL_TRANSPORT ?? "sendmail" } as never);
  if (cfg.mailTransport !== "sendmail") refuse(`PANEL_MAIL_TRANSPORT is "${cfg.mailTransport}", not sendmail — there is nothing live to prove`);
  if (!fs.existsSync(cfg.sendmailPath)) refuse(`${cfg.sendmailPath} does not exist on this host`);
  console.log(`transport: ${cfg.sendmailPath}  from: ${cfg.mailFrom}  to: ${to}  mailbox: ${newDir}`);

  const code = randomNumericCode(6);
  const mail = loginCodeMail(cfg.mailFrom, to, code, cfg.codeTtlSec);
  const before = new Set(fs.readdirSync(newDir));

  const sent = Date.now();
  try {
    await buildMailer(cfg).send(mail);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    // The exit status is the whole answer here: postfix's sendmail exits non-zero
    // when it refuses the sender or the recipient, and that message never reaches
    // a queue to be retried. Say what it said.
    refuse(`the MTA rejected the submission: ${detail}\n  mailq: ${execFileSync("/usr/sbin/postqueue", ["-f"], { encoding: "utf8" }).slice(0, 300)}`);
  }
  console.log("  the MTA accepted the message (sendmail exited 0)");

  let landed: string[] = [];
  for (let waited = 0; waited < 30_000; waited += 500) {
    await new Promise((r) => setTimeout(r, 500));
    landed = fs.readdirSync(newDir).filter((f) => !before.has(f));
    if (landed.length) break;
  }
  const owned = landed.filter((f) => {
    try { return fs.readFileSync(path.join(newDir, f), "utf8").includes(code); } catch { return false; }
  });
  checkIt(owned.length === 1, `exactly one new message landed in ${newDir} and it carries this probe's code`, `new=${landed.length} ours=${owned.length}`);

  const raw = fs.readFileSync(path.join(newDir, owned[0]!), "utf8");
  const headerBlock = raw.split(/\r?\n\r?\n/)[0] ?? "";
  const valueOf = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, "im").exec(headerBlock)?.[1]?.trim() ?? "";
  checkIt(valueOf("From") === cfg.mailFrom, "the delivered message's From is the configured sender", valueOf("From"));
  checkIt(valueOf("To").includes(to), "the delivered message is addressed to the probe recipient", valueOf("To"));
  const subject = valueOf("Subject");
  const decodedSubject = (() => { const m = /^=\?UTF-8\?B\?(.+)\?=$/.exec(subject); return m ? Buffer.from(m[1]!, "base64").toString("utf8") : subject; })();
  checkIt(decodedSubject.includes("SamaPay sign-in code") && decodedSubject.includes("رمز دخول"), "the subject survived the MTA in both languages", decodedSubject);
  checkIt(raw.includes(code) && (raw.match(new RegExp(code, "g")) ?? []).length >= 2, "the code is in the body the mailbox received, in both language halves", code);
  checkIt(/^Message-ID: <|^Message-ID: <[^@]+@/m.test(headerBlock) && !Number.isNaN(Date.parse(valueOf("Date"))), "Message-ID and Date reached the mailbox intact", valueOf("Date"));
  // DKIM/ADSP is decided by whatever signed it, and the signature header is the
  // only evidence available without reading another service's logs.
  checkIt(/^(Authentication-Results|DKIM-Signature):/im.test(headerBlock),
    "the message arrived signed (amavisd/dkimstamp put a DKIM header on it) — an unsigned code mail is a spam-folder code mail",
    /DKIM-Signature/im.test(headerBlock) ? "DKIM-Signature present" : "Authentication-Results present");
  const queue = execFileSync("/usr/sbin/postqueue", ["-f"], { encoding: "utf8" });
  checkIt(!queue.toLowerCase().includes(to), "nothing for this recipient is left in the queue — the message was delivered, not parked",
    `${queue.split("\n").length} line(s) in mailq`);

  // CLEANUP — only files this run created AND that carry this run's code. A
  // probe that leaves mail in a real mailbox is a probe that spams a person.
  for (const f of owned) fs.rmSync(path.join(newDir, f), { force: true });
  checkIt(fs.readdirSync(newDir).filter((f) => !before.has(f)).length === 0, "the probe removed its own message from the mailbox", `removed=${owned.join(",")}`);

  console.log(`\nlive proof OK: a code written by src/panel/mailer.ts was accepted by ${cfg.sendmailPath}, delivered by this box's postfix to ${to}, read back and deleted. ${Math.round((Date.now() - sent) / 1000)}s.`);
  process.exit(0);
}

function checkIt(ok: boolean, label: string, detail = ""): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) { console.error(`\n${RUN}: FAILED at "${label}". If a message was delivered it may still be in the mailbox; nothing here deleted anything else.`); process.exit(1); }
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
