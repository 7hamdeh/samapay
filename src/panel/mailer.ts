// Outbound email for login codes. SamaPay has no SMTP dependency, and adding
// one is a supply decision; `/usr/sbin/sendmail` (measured present on this box)
// is the classic local-MTA path and needs no new package, no credentials in
// this process, and no network egress from the app itself.
//
// THE PORT IS THE POINT: every verify script injects a fake, so no test can
// send real mail by accident, and the transport that talks to the world is one
// file nobody has to read to understand a code's lifecycle.
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
    return new Promise((resolve, reject) => {
      const child = spawn(this.path, ["-t", "-i"], { stdio: ["pipe", "ignore", "pipe"] });
      let err = "";
      child.stderr.on("data", (d) => { err = (err + d.toString()).slice(-400); });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`mailer: sendmail exited ${code}: ${err}`))));
      // Headers are built here, not by a library, so nothing merchant-supplied
      // can inject a header: the only interpolated value is the validated address.
      const safe = (s: string) => s.replace(/[\r\n]/g, "");
      child.stdin.end(
        `From: ${safe(this.from)}\r\n` +
        `To: <${safe(mail.to)}>\r\n` +
        `Subject: ${safe(mail.subject)}\r\n` +
        `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
        `${mail.text}\r\n`,
      );
    });
  }
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
