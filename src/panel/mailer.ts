// Outbound email for login codes. SamaPay has no SMTP dependency, and adding
// one is a supply decision; `/usr/sbin/sendmail` (measured present on this box)
// is the classic local-MTA path and needs no new package, no credentials in
// this process, and no network egress from the app itself.
//
// THE PORT IS THE POINT: every verify script injects a fake, so no test can
// send real mail by accident, and the transport that talks to the world is one
// file nobody has to read to understand a code's lifecycle.
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import type { PanelConfig } from "./config.js";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}
export interface Mailer {
  send(mail: Mail): Promise<void>;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export function isPlausibleEmail(email: string): boolean {
  return email.length <= 320 && EMAIL_SHAPE.test(email);
}

/** Bilingual, because the estate is Arabic-first and this email is the only
 *  text a merchant sees before the dashboard exists for them. */
export function loginCodeMail(from: string, email: string, code: string, ttlSec: number): Mail {
  return {
    to: email,
    subject: "SamaPay sign-in code · رمز دخول SamaPay",
    text:
`Your SamaPay sign-in code is: ${code}

It works once, and for ${Math.round(ttlSec / 60)} minutes. Nobody at SamaPay will ever ask you for it, and support cannot sign in for you.

رمز الدخول إلى SamaPay الخاص بك هو: ${code}

يُستخدم الرمز مرة واحدة وهو صالح لمدة ${Math.round(ttlSec / 60)} دقيقة. لن يطلبه منك أحد في SamaPay أبداً، ولا يستطيع الدعم تسجيل الدخول نيابةً عنك.
`,
  };
}

class SendmailMailer implements Mailer {
  constructor(private readonly path: string, private readonly from: string) {}
  send(mail: Mail): Promise<void> {
    if (!isPlausibleEmail(mail.to)) return Promise.reject(new Error("mailer: refusing a malformed recipient"));
    // The From is config, not merchant input — but it is also the envelope
    // sender below, so a typo here is a month of codes landing in spam before
    // anyone connects the two. Refuse it at boot-of-send, where the name of the
    // variable is the error message.
    if (!isPlausibleEmail(this.from)) return Promise.reject(new Error(`mailer: PANEL_MAIL_FROM is not an address ("${this.from}") — refusing to hand the MTA a message with no usable envelope sender`));
    return new Promise((resolve, reject) => {
      const child = spawn(this.path, ["-t", "-i", "-f", this.from], { stdio: ["pipe", "ignore", "pipe"] });
      let err = "";
      child.stderr.on("data", (d) => { err = (err + d.toString()).slice(-400); });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`mailer: sendmail exited ${code}: ${err}`))));
      child.stdin.end(this.rfc822(mail));
    });
  }

  /** The exact bytes handed to the MTA's stdin. Built here rather than by a
   *  library because the whole attack surface of this file is header injection,
   *  and a hand-written header block is one where every interpolated value can
   *  be named: `from` is config and validated, `to` is validated at the door,
   *  `subject` is encoded rather than passed through, and nothing merchant-
   *  supplied reaches any of them. */
  private rfc822(mail: Mail): string {
    const domain = this.from.slice(this.from.indexOf("@") + 1);
    const messageId = `<${randomBytes(12).toString("hex")}.${Date.now()}@${domain}>`;
    return [
      `From: ${oneLine(this.from)}`,
      `To: <${oneLine(mail.to)}>`,
      `Subject: ${encodedWord(mail.subject)}`,
      // toUTCString() is RFC 1123 with a literal "GMT" zone, which is a legal
      // Date and the one this process can produce without a formatter.
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: ${messageId}`,
      // RFC 3834: an automated message, so vacation responders and filters that
      // honour it stay quiet instead of answering a sign-in code with "I'm away".
      "Auto-Submitted: auto-replied",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      // Declared, not assumed: without this an MTA on the other side is entitled
      // to treat the body as us-ascii, which is where the Arabic half of a
      // bilingual code message turns into mojibake for the reader who needs it.
      "Content-Transfer-Encoding: 8bit",
      "",
      "",
    ].map((l) => l.replace(/[\r\n]/g, "")).join("\r\n") + mail.text.replace(/\r?\n/g, "\r\n") + "\r\n";
  }
}

/** A header value can only ever be one line. Applied to every interpolation,
 *  so the shape of the guard does not depend on who added the next header. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]/g, "");
}

/** RFC 2047 encoded-word. The subject is bilingual and a non-ASCII header sent
 *  as raw UTF-8 is at the receiving client's discretion — some show it, some
 *  show `=?...?=` garbage, one rejects the message. Base64 because it needs no
 *  line-folding at this length. */
function encodedWord(value: string): string {
  const clean = oneLine(value);
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7E]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

/** Writes nothing and says so. Chosen only by an explicit config value so a
 *  misconfigured prod cannot quietly mail nobody. */
class LogMailer implements Mailer {
  constructor(private readonly log: (m: string) => void, private readonly dir?: string) {}
  async send(mail: Mail): Promise<void> {
    this.log(`[panel-mail] to=${mail.to} subject=${mail.subject} body_bytes=${mail.text.length}${this.dir ? ` dir=${this.dir}` : ""}`);
  }
}

class RefusingMailer implements Mailer {
  async send(): Promise<void> {
    throw new Error("panel mailer: PANEL_MAIL_TRANSPORT is \"none\" — a login code cannot be delivered. Set it to sendmail (or log, in a sandbox).");
  }
}

export function buildMailer(cfg: PanelConfig, log: (m: string) => void = console.error): Mailer {
  switch (cfg.mailTransport) {
    case "sendmail": return new SendmailMailer(cfg.sendmailPath, cfg.mailFrom);
    case "log": return new LogMailer(log);
    case "none": return new RefusingMailer();
  }
}

/** Test double: records, never sends. */
export class FakeMailer implements Mailer {
  readonly outbox: Mail[] = [];
  async send(mail: Mail): Promise<void> { this.outbox.push(mail); }
}
