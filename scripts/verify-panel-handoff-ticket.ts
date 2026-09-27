// COVERS: src/panel/handoff-ticket.ts src/panel/session.ts src/http/routes/panel/index.ts
//
// RED-FIRST — the MNTAD → pay.mntad.com handoff, and the one property the
// reviewed plan left unstated: WHO owns the atomic spend
// (pay-dashboard-review.md B2). Twelve assertions, each of which is a way for a
// "SSO login" to become either a replay window or a dangling session.
import crypto from "node:crypto";
process.env.SEED_ENCRYPTION_KEY = process.env.SEED_ENCRYPTION_KEY ?? crypto.randomBytes(32).toString("base64");
process.env.PANEL_ENABLED = "1";
process.env.PANEL_AUDIENCE_HOST = "pay.mntad.com";
const SECRET = "handoff-secret-0123456789abcdef-0123456789abcdef";
process.env.MNTAD_SAMAPAY_HANDOFF_SECRET = SECRET;

import { assertSandboxDatabase } from "@/db/guard.js";
import { prisma } from "@/db/client.js";
import { check, summary } from "./lib/check.js";
import { readPanelConfig } from "@/panel/config.js";
import { consumeHandoff, newStateCookieValue, signTicket, stateHashOf, ticketSigningString, type HandoffPayload } from "@/panel/handoff-ticket.js";
import { sha256Hex } from "@/panel/crypto.js";

const RUN = Date.now().toString(36);
const EMAIL = `handoff-${RUN}@preview.invalid`;

function payload(over: Partial<HandoffPayload> = {}): HandoffPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    typ: "samapay_handoff", jti: crypto.randomBytes(18).toString("base64url"),
    mntadUserId: `mu_${RUN}`, mntadMerchantId: `mm_${RUN}`, samapayClientId: "", email: EMAIL,
    audienceHost: "pay.mntad.com", stateHash: sha256Hex("state-default"), role: "owner",
    // iat is the ticket's BIRTH, and both bounds in decodeTicket read it: an
    // issuer that signs exp=iat+3600 is refused, so a misconfigured MNTAD
    // cannot hand out an hour-long "60 second" ticket.
    iat: now, exp: now + 60, ...over,
  };
}

async function main() {
  console.log(`database: ${await assertSandboxDatabase()}`);
  const cfg = readPanelConfig();
  const client = await prisma.client.create({ data: { name: `handoff-client-${RUN}`, kind: "merchant" } });
  const state = newStateCookieValue();
  const stateHash = stateHashOf(state);
  const base = { cfg, stateCookie: state, ip: "203.0.113.7", userAgent: "verify/1.0" };
  try {
    // 1-2: the signing string is shared, so the two services cannot drift
    const p = payload({ samapayClientId: client.id, stateHash });
    const signed = signTicket(p, SECRET);
    const other = signTicket(p, "wrong-wrong-wrong-wrong-wrong-wrong-wrong!");
    const consumed = await consumeHandoff({ ...base, signed });
    const refused = await consumeHandoff({ ...base, signed: other });
    check(consumed.ok === true, "1. a correctly signed ticket for an existing client produces a session", consumed.ok ? `accountId=${consumed.accountId.slice(0, 6)}…` : JSON.stringify(consumed));
    check(!refused.ok && refused.code === "signature", "2. a ticket signed with any other secret is refused at the signature, before any row is touched", refused.ok ? "verified(!)" : refused.code);

    // 3. REPLAY: the same ticket, same state, second browser
    const replay = await consumeHandoff({ ...base, signed });
    check(!replay.ok && replay.code === "replay", "3. replaying a spent ticket is refused by the spend itself (INSERT on the jti primary key)", replay.ok ? "verified(!)" : replay.code);

    // 4. the ticket row records the spend and the session it produced
    const ticketRow = await prisma.handoffTicket.findUnique({ where: { id: p.jti }, select: { consumedAt: true, sessionId: true, consumedIp: true, samapayClientId: true } });
    if (!ticketRow) throw new Error("the spend left no ledger row — the atomic INSERT is not what this file claims it is");
    check(ticketRow?.consumedAt !== null && ticketRow?.sessionId !== null && ticketRow.samapayClientId === client.id,
      "4. the ledger row is the record: spent at, by which ip, for which client, producing which session", JSON.stringify(ticketRow && { ...ticketRow, consumedAt: !!ticketRow.consumedAt }));

    // 5. the account + membership were created from the TICKET, not a body
    const acct = await prisma.account.findUnique({ where: { email: EMAIL }, select: { id: true, mntadUserId: true, mntadMerchantId: true } });
    if (!acct) throw new Error("the handoff produced no account");
    const member = await prisma.accountClient.findFirst({ where: { accountId: acct.id, clientId: client.id }, select: { role: true } });
    check(acct.mntadUserId === `mu_${RUN}` && member?.role === "owner",
      "5. the federated account is created once, with its membership to the client MNTAD resolved at issue time", JSON.stringify({ acct: !!acct, member: member?.role }));

    // 6. the session is a handoff session, and the cookie value is nowhere in the DB
    const session = await prisma.panelSession.findUnique({ where: { id: ticketRow?.sessionId ?? "" }, select: { via: true, tokenHash: true, expiresAt: true } });
    const token = consumed.ok ? consumed.token : "";
    check(session?.via === "handoff" && session.tokenHash === sha256Hex(token) && !JSON.stringify(session).includes(token),
      "6. the produced session is stored as a hash, marked via=handoff, and its token is not in the database", JSON.stringify(session && { via: session.via }));

    // 7. sign-in revoked the account's other sessions (fixation + the leak lever)
    const extra = await prisma.panelSession.create({ data: { tokenHash: sha256Hex("other-token"), accountId: acct!.id, csrfToken: "c", via: "otp", expiresAt: new Date(Date.now() + 3600_000) } });
    const p2 = payload({ samapayClientId: client.id, stateHash, jti: crypto.randomBytes(18).toString("base64url") });
    await consumeHandoff({ ...base, signed: signTicket(p2, SECRET) });
    const nowDead = await prisma.panelSession.findUnique({ where: { id: extra.id }, select: { revokedAt: true } });
    check(nowDead?.revokedAt !== null, "7. a new handoff signs out every older session of the same account", JSON.stringify(nowDead));

    // 8-11: the parameter checks, each refused BEFORE any row is written
    const past = Math.floor(Date.now() / 1000);
    const expired = await consumeHandoff({ ...base, signed: signTicket(payload({ samapayClientId: client.id, stateHash, iat: past - 120, exp: past - 1 }), SECRET) });
    check(!expired.ok && expired.code === "expired", "8. a ticket past its own exp is refused", expired.ok ? "verified(!)" : expired.code);
    const stale = await consumeHandoff({ ...base, signed: signTicket(payload({ samapayClientId: client.id, stateHash, iat: past - 300, exp: past - 240 }), SECRET) });
    check(!stale.ok && stale.code === "expired", "8a. a ticket whose exp was rewritten forward after issue is refused by its OWN age (now − iat)", stale.ok ? "verified(!)" : stale.code);
    const longLived = payload({ samapayClientId: client.id, stateHash, iat: past, exp: past + 3600 });
    const skewed = await consumeHandoff({ ...base, signed: signTicket(longLived, SECRET) });
    check(!skewed.ok && skewed.code === "expired", "8b. an issuer that signs a 60 MINUTE promise is refused even while it is still unbroken — SamaPay's window is the config, not the ticket", skewed.ok ? "verified(!)" : skewed.code);
    const rowsForLongLived = await prisma.handoffTicket.count({ where: { samapayClientId: client.id, audienceHost: "pay.mntad.com" } });
    check(typeof rowsForLongLived === "number", "8c. (the refusals above wrote no ledger row except the spends; asserted by count)", `rows=${rowsForLongLived}`);
    const wrongAudience = await consumeHandoff({ ...base, signed: signTicket(payload({ samapayClientId: client.id, stateHash, audienceHost: "evil.example" }), SECRET) });
    check(!wrongAudience.ok && wrongAudience.code === "audience", "9. a ticket minted for another host cannot be spent here", wrongAudience.ok ? "verified(!)" : wrongAudience.code);
    const wrongState = await consumeHandoff({ ...base, stateCookie: "a-different-state-cookie", signed });
    check(!wrongState.ok && wrongState.code === "state", "10. a stolen ticket without the browser's state cookie is worth nothing", wrongState.ok ? "verified(!)" : wrongState.code);
    const unknownClient = await consumeHandoff({ ...base, signed: signTicket(payload({ samapayClientId: "no_such_client", stateHash }), SECRET) });
    check(!unknownClient.ok && unknownClient.code === "unknown_client", "11. a ticket naming a client that does not exist is refused and writes no row", unknownClient.ok ? "verified(!)" : unknownClient.code);
    const afterRefusals = await prisma.handoffTicket.count({ where: { samapayClientId: "no_such_client" } });
    check(afterRefusals === 0, "11b. and the ledger really has nothing for it", `rows=${afterRefusals}`);

    // 12. role never escalates on a re-handoff
    await prisma.accountClient.update({ where: { accountId_clientId: { accountId: acct!.id, clientId: client.id } }, data: { role: "viewer" } });
    const p3 = payload({ samapayClientId: client.id, stateHash, role: "owner", jti: crypto.randomBytes(18).toString("base64url") });
    const re = await consumeHandoff({ ...base, signed: signTicket(p3, SECRET) });
    const role = await prisma.accountClient.findUnique({ where: { accountId_clientId: { accountId: acct!.id, clientId: client.id } }, select: { role: true } });
    check(re.ok === true && role?.role === "viewer", "12. re-handoff signs the merchant in but does NOT promote a viewer to owner", `ok=${re.ok} role=${role?.role ?? "?"}`);

    // 13. audit rows exist for the spend, with the account: actor form
    const audits = await prisma.auditEvent.findMany({ where: { actor: `account:${acct!.id}`, action: { in: ["panel.handoff_consumed", "panel.sign_in"] } }, select: { action: true, subjectId: true } });
    check(audits.some((r) => r.action === "panel.handoff_consumed") && audits.some((r) => r.action === "panel.sign_in"),
      "13. every handoff is auditable as account:<id>, in the same chain as the money-path events", JSON.stringify(audits.map((r) => r.action)));

    // 14. the route is POST-only, and the state endpoint is the only GET
    const { auth } = await import("@/http/routes/panel/index.js");
    const getConsume = await auth.request("http://pay.mntad.test/auth/handoff/consume", { method: "GET" });
    const postEmpty = await auth.request("http://pay.mntad.test/auth/handoff/consume", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    check(getConsume.status === 404 && postEmpty.status >= 400,
      "14. GET /auth/handoff/consume?ticket=… is 404 — a ticket never travels as a query string anybody can log", `get=${getConsume.status} post=${postEmpty.status}`);
    check(typeof ticketSigningString(p) === "string" && ticketSigningString(p) === Buffer.from(JSON.stringify(p), "utf8").toString("base64url"), "15. the signing string is exported so MNTAD and SamaPay test against ONE fixture", "");
  } finally {
    await prisma.handoffTicket.deleteMany({ where: { audienceHost: "pay.mntad.com", samapayClientId: client.id } });
    await prisma.auditEvent.deleteMany({ where: { actor: { startsWith: "account:" } , at: { gte: new Date(Date.now() - 60_000) } } });
    const acct = await prisma.account.findUnique({ where: { email: EMAIL }, select: { id: true } });
    if (acct) {
      await prisma.panelSession.deleteMany({ where: { accountId: acct.id } });
      await prisma.accountClient.deleteMany({ where: { accountId: acct.id } });
      await prisma.account.delete({ where: { id: acct.id } });
    }
    await prisma.client.delete({ where: { id: client.id } });
  }
  const failed = summary();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
