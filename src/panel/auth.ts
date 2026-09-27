// The sign-in state machine, with no route in it — so every branch is testable
// without a server, and so a route cannot quietly skip a step.
//
// TWO ENDS OF ONE RULE: the code proves the mailbox; the session proves the
// person. Neither alone is enough, which is why `verifyCode` never returns a
// cookie and `issueSession` is only reachable from a spent code or a consumed
// handoff. 2FA is OPTIONAL and, when enabled, is checked between the two:
// a code that has been spent without a TOTP step must not be re-spendable, so
// a pending-2FA state is a short-lived, single-use token, not a half-session.
import { prisma } from "@/db/client.js";
import { appendAudit } from "@/audit/append.js";
import { decryptTotpSecret, sha256Hex } from "./crypto.js";
import { verifyTotpCode } from "./totp.js";
import { issueLoginCode, verifyLoginCode, type CodePurpose } from "./login-code.js";
import { createSession, revokeAllSessions, type PanelVia } from "./session.js";
import { touchSignIn } from "./accounts.js";
import { isPlausibleEmail, normalizeEmail } from "./email.js";
import type { PanelConfig } from "./config.js";
import type { Mailer } from "./mailer.js";

export type AuthOutcome =
  | { ok: true; token: string; csrfToken: string; expiresAt: Date; accountId: string; email: string }
  | { ok: false; code: "invalid_code" | "email_invalid" | "account_disabled" | "totp_required" | "totp_invalid" | "no_such_account" | "account_exists" };

export interface AuthDeps {
  cfg: PanelConfig;
  mailer: Mailer;
  now?: () => Date;
  ip: string | null;
  userAgent: string | null;
}

export async function requestCode(input: { email: string; purpose: CodePurpose; name?: string | null }, deps: AuthDeps): Promise<{ ok: true } | { ok: false; code: "email_invalid" }> {
  const email = normalizeEmail(input.email);
  if (!isPlausibleEmail(email)) return { ok: false, code: "email_invalid" };
  if (input.purpose === "sign_up") {
    // "Sign up" is not an oracle for "this address is already a merchant": the
    // answer is the same either way and the flow continues into a sign-in.
    const existing = await prisma.account.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
      await appendAudit(prisma, { actor: `pending:${sha256Hex(email).slice(0, 16)}`, action: "panel.sign_up_collided", subjectId: existing.id });
    } else {
      await prisma.account.create({ data: { email, ...(input.name ? { displayName: input.name } : {}) } });
    }
  }
  await issueLoginCode({
    email, purpose: input.purpose, mailer: deps.mailer, mailFrom: deps.cfg.mailFrom,
    createdFromIp: deps.ip, cfg: { ttlSec: deps.cfg.codeTtlSec, maxAttempts: deps.cfg.codeMaxAttempts },
  });
  return { ok: true };
}

/** Verify a code and, if the account has 2FA on, require the TOTP step in the
 *  SAME request. There is no intermediate "code spent, waiting for TOTP" state
 *  to leak: without a valid TOTP the code is not spent. */
export async function completeSignIn(input: { email: string; purpose: CodePurpose; code: string; totp?: string | null }, deps: AuthDeps): Promise<AuthOutcome> {
  const email = normalizeEmail(input.email);
  if (!isPlausibleEmail(email)) return { ok: false, code: "email_invalid" };
  const account = await prisma.account.findUnique({ where: { email } });
  if (!account) return { ok: false, code: "no_such_account" };
  if (account.disabledAt !== null) return { ok: false, code: "account_disabled" };

  if (account.totpEnabledAt !== null && account.totpSecretEnc !== null) {
    const secret = decryptTotpSecret(deps.cfg.seedEncryptionKey ?? "", account.totpSecretEnc);
    if (!secret) return { ok: false, code: "totp_invalid" }; // an unreadable secret is a refusal, never a bypass
    if (!input.totp) return { ok: false, code: "totp_required" };
    if (!verifyTotpCode(secret, input.totp)) return { ok: false, code: "totp_invalid" };
  }

  const verified = await verifyLoginCode({ email, purpose: input.purpose, code: input.code, cfg: { ttlSec: deps.cfg.codeTtlSec, maxAttempts: deps.cfg.codeMaxAttempts }, ...(deps.now ? { now: deps.now() } : {}) });
  if (!verified.ok) return { ok: false, code: "invalid_code" };

  const via: PanelVia = "otp";
  const session = await createSession({ accountId: account.id, via, ip: deps.ip, userAgent: deps.userAgent, cfg: deps.cfg });
  await appendAudit(prisma, {
    actor: `account:${account.id}`, action: "panel.sign_in", subjectId: session.sessionId,
    params: { via, totp: account.totpEnabledAt !== null },
  });
  await touchSignIn(account.id);
  return { ok: true, token: session.token, csrfToken: session.csrfToken, expiresAt: session.expiresAt, accountId: account.id, email: account.email };
}

export async function signOut(input: { accountId: string; sessionId: string }): Promise<void> {
  await prisma.panelSession.updateMany({ where: { id: input.sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
  await appendAudit(prisma, { actor: `account:${input.accountId}`, action: "panel.sign_out", subjectId: input.sessionId });
}

/** The leak-recovery and role-change lever: kill every session this account has
 *  except the one the merchant is sitting in. */
export async function revokeEveryOtherSession(accountId: string, keepSessionId: string): Promise<number> {
  return revokeAllSessions(accountId, keepSessionId);
}
