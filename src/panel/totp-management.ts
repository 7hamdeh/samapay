// Optional 2FA for panel accounts.
//
// ENROLLMENT IS TWO STEPS BECAUSE A CODE THAT HAS NEVER BEEN PROVEN IS NOT A
// FACTOR. `beginTotpEnrollment` writes the secret but leaves `totpEnabledAt`
// null, and sign-in only consults a secret when that timestamp is set
// (src/panel/auth.ts), so a half-finished enrollment can neither lock an owner
// out nor be mistaken for protection. `activateTotp` proves the device holds
// the same secret the server just generated, and only then flips it on.
//
// ACTIVATION REVOKES EVERY OTHER SESSION. Turning on a second factor is the
// moment an owner says "the previous sessions were not enough"; keeping them
// alive would make the enrollment decorative. Same lever as the leak-recovery
// path, for the same reason (session fixation, and a stolen cookie that
// outlives the change meant to revoke it).
import { prisma } from "@/db/client.js";
import { appendAudit } from "@/audit/append.js";
import { decryptTotpSecret, encryptTotpSecret, sha256Hex } from "./crypto.js";
import { generateBackupCodes, generateTotpSecret, normalizeBackup, otpauthUri, verifyTotpCode } from "./totp.js";
import { readPanelConfig } from "./config.js";
import { revokeAllSessions } from "./session.js";

export type TotpRefusal = { ok: false; code: "no_pending_enrollment" | "code_invalid" | "already_enabled" | "not_enabled" | "no_encryption_key" };

export async function beginTotpEnrollment(input: { accountId: string }): Promise<{ ok: true; otpauthUri: string; secret: string } | TotpRefusal> {
  const cfg = readPanelConfig();
  if (!cfg.seedEncryptionKey) return { ok: false, code: "no_encryption_key" };
  const account = await prisma.account.findUnique({ where: { id: input.accountId }, select: { email: true, totpEnabledAt: true } });
  if (!account) return { ok: false, code: "no_pending_enrollment" };
  if (account.totpEnabledAt !== null) return { ok: false, code: "already_enabled" };
  const secret = generateTotpSecret(20);
  await prisma.account.update({ where: { id: input.accountId }, data: { totpSecretEnc: encryptTotpSecret(cfg.seedEncryptionKey, secret) } });
  await appendAudit(prisma, { actor: `account:${input.accountId}`, action: "panel.totp.enrollment_started", subjectId: input.accountId });
  // The secret is returned so the QR/URI can be rendered once, on the setup
  // screen only. It is not readable again — there is no GET for it.
  return { ok: true, otpauthUri: otpauthUri(account.email, secret), secret };
}

export async function activateTotp(input: { accountId: string; sessionId: string; code: string }): Promise<{ ok: true; backupCodes: string[] } | TotpRefusal> {
  const cfg = readPanelConfig();
  if (!cfg.seedEncryptionKey) return { ok: false, code: "no_encryption_key" };
  const account = await prisma.account.findUnique({ where: { id: input.accountId }, select: { totpEnabledAt: true, totpSecretEnc: true } });
  if (!account?.totpSecretEnc) return { ok: false, code: "no_pending_enrollment" };
  if (account.totpEnabledAt !== null) return { ok: false, code: "already_enabled" };
  const secret = decryptTotpSecret(cfg.seedEncryptionKey, account.totpSecretEnc);
  if (!secret) return { ok: false, code: "no_pending_enrollment" };
  if (!verifyTotpCode(secret, input.code)) return { ok: false, code: "code_invalid" };

  const backups = generateBackupCodes(10);
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.account.update({ where: { id: input.accountId }, data: { totpEnabledAt: now } });
    await tx.panelBackupCode.createMany({ data: backups.hashes.map((codeHash) => ({ accountId: input.accountId, codeHash })) });
    await appendAudit(tx, { actor: `account:${input.accountId}`, action: "panel.totp.enabled", subjectId: input.accountId, params: { backup_codes: backups.hashes.length } });
    await tx.panelSession.updateMany({ where: { accountId: input.accountId, revokedAt: null, id: { not: input.sessionId } }, data: { revokedAt: now } });
    await appendAudit(tx, { actor: `account:${input.accountId}`, action: "panel.sessions_revoked", subjectId: input.sessionId, params: { reason: "totp_enabled" } });
  });
  return { ok: true, backupCodes: backups.plaintext };
}

/** A backup code is a second factor in a drawer: it unlocks 2FA when the device
 *  is gone, and it is destroyed by being used. */
export async function consumeBackupCode(input: { accountId: string; code: string }): Promise<boolean> {
  const hash = normalizeBackup(input.code);
  const spent = await prisma.panelBackupCode.updateMany({ where: { accountId: input.accountId, codeHash: hash, usedAt: null }, data: { usedAt: new Date() } });
  if (spent.count === 1) await appendAudit(prisma, { actor: `account:${input.accountId}`, action: "panel.totp.backup_used", subjectId: input.accountId });
  return spent.count === 1;
}

/** Turning 2FA OFF costs the second factor — by TOTP or by a printed backup
 *  code, the same two proofs the account already accepts.
 *
 *  WHY THIS IS NOT A `requireTotp` Nicety (pay-dashboard review 2026-09-27,
 *  MEDIUM on item 2): this function deletes the secret AND every backup code,
 *  so before this it was one authenticated POST away from converting a
 *  two-factor account into a one-factor account — with a session cookie and a
 *  CSRF token as the whole of the authorisation, which is exactly what a
 *  hijacked session holds. ENABLING 2FA revokes every other session; DISABLING
 *  it asked for nothing. The asymmetry was the finding.
 *
 *  ⚠️ NOTHING HERE CHECKS A CODE IT DID NOT ACCEPT: a refusal leaves the
 *  secret in place and spends no backup code, so a wrong guess is not a way to
 *  burn through the recovery set. The rate limit that keeps the guess cheap
 *  for the attacker is the `second_factor` bucket on the route, not here.
 */
export async function disableTotp(input: { accountId: string; code: string }): Promise<{ ok: true; via: "totp" | "backup" } | TotpRefusal> {
  const cfg = readPanelConfig();
  if (!cfg.seedEncryptionKey) return { ok: false, code: "no_encryption_key" };
  const account = await prisma.account.findUnique({ where: { id: input.accountId }, select: { totpEnabledAt: true, totpSecretEnc: true } });
  if (!account || account.totpEnabledAt === null) return { ok: false, code: "not_enabled" };
  // An unreadable secret is not "no factor needed": the backups still open the
  // door, which is the whole point of printing them.
  const secret = account.totpSecretEnc ? decryptTotpSecret(cfg.seedEncryptionKey, account.totpSecretEnc) : null;
  const via = secret !== null && verifyTotpCode(secret, input.code) ? "totp" as const : null;
  if (via === null && !(await consumeBackupCode({ accountId: input.accountId, code: input.code }))) {
    await appendAudit(prisma, { actor: `account:${input.accountId}`, action: "panel.totp.disable_refused", subjectId: input.accountId });
    return { ok: false, code: "code_invalid" };
  }
  const proved = via ?? "backup" as const;
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.account.update({ where: { id: input.accountId }, data: { totpEnabledAt: null, totpSecretEnc: null } });
    await tx.panelBackupCode.deleteMany({ where: { accountId: input.accountId } });
    await appendAudit(tx, { actor: `account:${input.accountId}`, action: "panel.totp.disabled", subjectId: input.accountId, params: { via: proved } });
  });
  return { ok: true, via: proved };
}

export async function totpStatus(accountId: string): Promise<{ enabled: boolean; pending: boolean; backupCodesRemaining: number }> {
  const a = await prisma.account.findUnique({ where: { id: accountId }, select: { totpEnabledAt: true, totpSecretEnc: true } });
  const remaining = await prisma.panelBackupCode.count({ where: { accountId, usedAt: null } });
  return { enabled: a?.totpEnabledAt !== null, pending: a?.totpEnabledAt === null && a?.totpSecretEnc != null, backupCodesRemaining: remaining };
}

export { sha256Hex };
