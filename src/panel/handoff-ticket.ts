// The MNTAD → pay.mntad.com handoff. SSO for a merchant already signed into
// stores.mntad.com, so SamaPay never becomes a second password system
// (pay-dashboard.md A.11-A.12, FINAL-RULINGS B#6).
//
// ONE SPEND LEDGER, ON THE CONSUMER'S SIDE — the fix for
// pay-dashboard-review.md B2. The reviewed plan put a ticket table on BOTH
// sides "so both can verify" without naming who burns the ticket. That is
// either a replay window (nobody owns an atomic spend) or a dangling auth
// (MNTAD burns it, SamaPay dies before the cookie, the merchant is stranded
// mid-air). Here:
//   · MNTAD signs a ticket and keeps NO consumed-state — it is an issuer.
//   · SamaPay's INSERT on the ticket's own `jti` (primary key) IS the spend.
//     A replay hits the unique index and gets the same generic refusal as a
//     bad signature. A crash after the insert, before the 302, costs the
//     merchant one more click and nothing else.
//   · The session is created in the SAME transaction as the spend, so there is
//     no state where a ticket is burned and nothing was produced for it.
//
// WHAT SAMA_PAY TRUSTS, SAPELLED OUT (review B2 says the plan understated
// this): `samapayClientId` arrives FROM THE TICKET, and there is no local fact
// to cross-check it against — SamaPay has no MNTAD session to compare with.
// The trust is delegated to MNTAD plus the shared secret, so the load-bearing
// invariant lives on that side: MNTAD must resolve `samapayClientId` from the
// store's OWN AEAD-encrypted credential, never from anything merchant-entered.
import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@/db/client.js";
import { appendAudit } from "@/audit/append.js";
import { canonical, randomToken, sha256Hex } from "./crypto.js";
import { normalizeEmail } from "./email.js";
import type { PanelConfig } from "./config.js";

export const HANDOFF_TYPE = "samapay_handoff";

export interface HandoffPayload {
  typ: typeof HANDOFF_TYPE;
  jti: string;
  mntadUserId: string;
  mntadMerchantId: string;
  samapayClientId: string;
  email: string;
  audienceHost: string;
  stateHash: string;
  role: "owner" | "viewer";
  /** When the issuer SIGNED it. Without `iat` a consumer can only compare
   *  `exp` to now, which means a misconfigured MNTAD that sets exp to
   *  now+3600 produces a ticket that is valid for an hour and looks fresh — the
   *  60 s rule would be a promise in a comment instead of a check. Both bounds
   *  are needed: `exp - iat` (how long the issuer CLAIMS to allow) and
   *  `now - iat` (how old it actually is). */
  iat: number;
  exp: number;
}

export type HandoffRefusal =
  | "malformed" | "signature" | "expired" | "audience" | "state" | "replay" | "unknown_client" | "not_owner";

class Refuse extends Error {
  constructor(readonly code: HandoffRefusal) { super(code); this.name = "Refuse"; }
}

function bodyOf(payload: HandoffPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** The exact string the signature covers, so MNTAD and SamaPay can be tested
 *  against ONE fixture instead of two guesses about the encoding. */
export function ticketSigningString(payload: HandoffPayload): string {
  return bodyOf(payload);
}

export function signTicket(payload: HandoffPayload, secret: string): string {
  const body = bodyOf(payload);
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function verifyBody(signed: string, secret: string): string | null {
  const dot = signed.lastIndexOf(".");
  if (dot <= 0 || dot === signed.length - 1) return null;
  const body = signed.slice(0, dot);
  const expect = createHmac("sha256", secret).update(body).digest();
  let given: Buffer;
  try { given = Buffer.from(signed.slice(dot + 1), "base64url"); } catch { return null; }
  if (given.length !== expect.length || !timingSafeEqual(given, expect)) return null;
  return body;
}

function safeHexEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex")); } catch { return false; }
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Pure verification — no DB, no clock beyond the passed `nowSec`, so every
 *  branch below is assertable in a test that takes two seconds to run. */
export function decodeTicket(input: {
  signed: string;
  secret: string;
  audienceHost: string;
  stateHash: string;
  nowSec: number;
  ttlSec: number;
}): { ok: true; payload: HandoffPayload } | { ok: false; code: HandoffRefusal } {
  const body = verifyBody(input.signed, input.secret);
  if (body === null) return { ok: false, code: "signature" };
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return { ok: false, code: "malformed" }; }
  const p = parsed as Record<string, unknown>;
  const isStr = (k: string): boolean => typeof p[k] === "string" && (p[k] as string).length > 0 && (p[k] as string).length <= 320;
  if (p.typ !== HANDOFF_TYPE || !isStr("jti") || !isStr("mntadUserId") || !isStr("mntadMerchantId")
    || !isStr("samapayClientId") || !isStr("email") || !isStr("audienceHost")
    || typeof p.exp !== "number" || typeof p.iat !== "number" || (p.role !== "owner" && p.role !== "viewer")
    || typeof p.stateHash !== "string" || !HEX64.test(p.stateHash)) {
    return { ok: false, code: "malformed" };
  }
  if (p.exp <= input.nowSec) return { ok: false, code: "expired" };
  // THE TWO BOUNDS. An issuer that signs a 20-minute promise is refused even
  // while that promise is still unbroken — SamaPay's window is the config, not
  // whatever the ticket says. `+ 5` is the only tolerance: clock skew between
  // two processes on one box is sub-second, and five seconds is what a
  // re-issued ticket in flight needs.
  if (p.exp - p.iat > input.ttlSec + 5) return { ok: false, code: "expired" };
  if (input.nowSec - p.iat > input.ttlSec + 5) return { ok: false, code: "expired" };
  if (p.iat - input.nowSec > 5) return { ok: false, code: "expired" };
  if (p.audienceHost !== input.audienceHost) return { ok: false, code: "audience" };
  if (!safeHexEq(p.stateHash, input.stateHash)) return { ok: false, code: "state" };
  return { ok: true, payload: p as unknown as HandoffPayload };
}

export interface ConsumedHandoff {
  ok: true; accountId: string; token: string; csrfToken: string; expiresAt: Date; clientId: string; role: "owner" | "viewer";
}

/** Verify, spend, link, session. Every refusal — no such client, already spent,
 *  disabled account — answers the SAME shape: none of them is a merchant's
 *  question, and each one on its own is an oracle over who is provisioned. */
export async function consumeHandoff(input: {
  signed: string;
  cfg: PanelConfig;
  stateCookie: string | null;
  ip: string | null;
  userAgent: string | null;
  nowSec?: number;
  /** Kill the account's other sessions on sign-in (fixation + the leak
   *  recovery path). Default on; a test may turn it off to assert it works. */
  revokeOtherSessions?: boolean;
}): Promise<ConsumedHandoff | { ok: false; code: HandoffRefusal }> {
  if (!input.cfg.handoffSecret) return { ok: false, code: "malformed" };
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const decoded = decodeTicket({
    signed: input.signed,
    secret: input.cfg.handoffSecret,
    audienceHost: input.cfg.audienceHost,
    stateHash: sha256Hex(input.stateCookie ?? ""),
    nowSec,
    ttlSec: input.cfg.handoffTtlSec,
  });
  if (!decoded.ok) return decoded;
  const p = decoded.payload;
  const email = normalizeEmail(p.email);
  const client = await prisma.client.findUnique({ where: { id: p.samapayClientId }, select: { id: true } });
  if (!client) return { ok: false, code: "unknown_client" };

  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const expiresAt = new Date((nowSec + input.cfg.sessionTtlSec) * 1000);
  const revokeOthers = input.revokeOtherSessions ?? true;
  try {
    const accountId = await prisma.$transaction(async (tx) => {
      const spent = await tx.$executeRaw`
        INSERT INTO "handoff_tickets"
          ("id", "mntad_user_id", "mntad_merchant_id", "samapay_client_id", "audience_host",
           "state_hash", "created_at", "expires_at", "consumed_at", "consumed_ip")
        VALUES
          (${p.jti}, ${p.mntadUserId}, ${p.mntadMerchantId}, ${p.samapayClientId}, ${p.audienceHost},
           ${p.stateHash}, to_timestamp(${p.iat}), to_timestamp(${p.exp}), to_timestamp(${nowSec}), ${input.ip})
        ON CONFLICT ("id") DO NOTHING`;
      if (spent !== 1) throw new Refuse("replay");

      const account = await tx.account.upsert({
        where: { email },
        create: { email, mntadUserId: p.mntadUserId, mntadMerchantId: p.mntadMerchantId, lastSignInAt: new Date(nowSec * 1000) },
        update: { mntadUserId: p.mntadUserId, mntadMerchantId: p.mntadMerchantId, lastSignInAt: new Date(nowSec * 1000) },
      });
      if (account.disabledAt !== null) throw new Refuse("not_owner");
      // A handoff NEVER escalates a role: an existing viewer stays a viewer
      // until somebody who can see the change makes it deliberately.
      await tx.accountClient.upsert({
        where: { accountId_clientId: { accountId: account.id, clientId: p.samapayClientId } },
        create: { accountId: account.id, clientId: p.samapayClientId, role: p.role },
        update: {},
      });
      if (revokeOthers) await tx.panelSession.updateMany({ where: { accountId: account.id, revokedAt: null }, data: { revokedAt: new Date(nowSec * 1000) } });
      const session = await tx.panelSession.create({
        data: { tokenHash: sha256Hex(token), accountId: account.id, csrfToken, via: "handoff", expiresAt, lastSeenIp: input.ip, userAgent: input.userAgent },
        select: { id: true },
      });
      await tx.$executeRaw`UPDATE "handoff_tickets" SET "session_id" = ${session.id} WHERE "id" = ${p.jti}`;
      await appendAudit(tx, {
        actor: `account:${account.id}`, action: "panel.handoff_consumed", subjectId: p.jti,
        params: { mntadUserId: p.mntadUserId, mntadMerchantId: p.mntadMerchantId, clientId: p.samapayClientId, role: p.role },
      });
      await appendAudit(tx, { actor: `account:${account.id}`, action: "panel.sign_in", subjectId: session.id, params: { via: "handoff" } });
      return account.id;
    });
    return { ok: true, accountId, token, csrfToken, expiresAt, clientId: p.samapayClientId, role: p.role };
  } catch (e) {
    if (e instanceof Refuse) return { ok: false, code: e.code };
    throw e;
  }
}

/** The state cookie MNTAD's browser must carry: host-only, 60 s, HttpOnly. The
 *  ticket binds its hash, so a stolen ticket without this cookie's value is
 *  worth nothing to the thief. */
export function newStateCookieValue(): string {
  return randomToken(24);
}
export function stateHashOf(value: string): string {
  return sha256Hex(value);
}
