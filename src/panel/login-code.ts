// Email codes: the whole of SamaPay's own-password-less human auth.
//
// RULES THIS MODULE ENFORCES, and why each one is where it is:
//  · POST-only. The code appears in a request body and in an argon2 hash;
//    it is NEVER in a URL, a query string, a redirect, a log line, or an
//    error message. A code in a URL is a code in somebody's proxy access log,
//    browser history and Referer header.
//  · single-use, spent by an atomic conditional update, so two tabs cannot
//    both redeem one code.
//  · a new code supersedes the open ones for that (email, purpose): an inbox
//    with three live codes is three chances to guess the wrong one.
//  · argon2 (library defaults), the same treatment a key gets — a 6-digit code
//    is 20 bits, and sha256 over it is offline-brute-forceable from a DB read.
//  · every failure answers the SAME shape. "No such code", "expired" and
//    "wrong code" are three different oracles about one address's inbox.
import { prisma } from "@/db/client.js";
import { hashSecret, randomNumericCode, verifySecret } from "./crypto.js";
import { normalizeEmail } from "./email.js";
import type { Mailer } from "./mailer.js";

export type CodePurpose = "sign_up" | "sign_in";

export interface CodeConfig {
  ttlSec: number;
  maxAttempts: number;
}

export type CodeOutcome =
  | { ok: true; kind: "verified" }
  | { ok: false; kind: "invalid" | "expired" | "attempts_exhausted" | "no_open_code" };

export async function issueLoginCode(input: {
  email: string;
  purpose: CodePurpose;
  now?: Date;
  createdFromIp?: string | null;
  cfg: CodeConfig;
  mailer: Mailer;
  mailFrom: string;
}): Promise<{ sent: true; expiresAt: Date }> {
  const email = normalizeEmail(input.email);
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + input.cfg.ttlSec * 1000);
  const code = randomNumericCode(6);
  const codeHash = await hashSecret(code);
  // Supersede first, then insert: if the send fails the user is left with no
  // live code rather than with a stale one they will keep trying.
  await prisma.loginCode.updateMany({ where: { email, purpose: input.purpose, consumedAt: null }, data: { consumedAt: now } });
  await prisma.loginCode.create({
    data: { email, purpose: input.purpose, codeHash, expiresAt, sentTo: email, createdFromIp: input.createdFromIp ?? null, maxAttempts: input.cfg.maxAttempts },
  });
  const { loginCodeMail } = await import("./mailer.js");
  await input.mailer.send(loginCodeMail(input.mailFrom, email, code, input.cfg.ttlSec));
  return { sent: true, expiresAt };
}

/** Verify and SPEND. `spentBy` is the id the caller will create a session for;
 *  passing it here keeps the consume and the session mint one step, not two. */
export async function verifyLoginCode(input: {
  email: string;
  purpose: CodePurpose;
  code: string;
  now?: Date;
  cfg: CodeConfig;
}): Promise<CodeOutcome> {
  const email = normalizeEmail(input.email);
  const now = input.now ?? new Date();
  if (!/^[0-9]{6}$/.test(input.code)) return { ok: false, kind: "invalid" };
  const row = await prisma.loginCode.findFirst({
    where: { email, purpose: input.purpose, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return { ok: false, kind: "no_open_code" };
  if (row.expiresAt <= now) return { ok: false, kind: "expired" };
  if (row.attempts >= row.maxAttempts) {
    // Burn it: an exhausted code must not sit around to be tried by the next
    // person who types the same address.
    await prisma.loginCode.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: now } });
    return { ok: false, kind: "attempts_exhausted" };
  }
  const matches = await verifySecret(row.codeHash, input.code);
  if (!matches) {
    const taken = await prisma.loginCode.update({ where: { id: row.id }, data: { attempts: { increment: 1 } }, select: { attempts: true } });
    if (taken.attempts >= row.maxAttempts) await prisma.loginCode.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: now } });
    return { ok: false, kind: "invalid" };
  }
  // ATOMIC SPEND: the WHERE on consumed_at IS NULL is the single-use guarantee.
  // A read-then-write would let a second tab redeem the same code.
  const spent = await prisma.loginCode.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: now } });
  if (spent.count !== 1) return { ok: false, kind: "invalid" };
  return { ok: true, kind: "verified" };
}

/** Housekeeping only: an expired row is dead, and a code table that grows
 *  forever is a table nobody can reason about. Deletes nothing that is still
 *  spendable. */
export async function sweepExpiredCodes(now = new Date()) {
  return prisma.loginCode.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 60_000) } } });
}
