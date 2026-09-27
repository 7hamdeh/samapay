// COVERS: src/panel/keys.ts src/panel/webhook.ts src/panel/read-views.ts src/panel/accounts.ts src/panel/audit.ts
//
// RED-FIRST — TENANT ISOLATION: "a merchant only sees its own data".
//
// The shape of every refusal matters as much as the refusal. Each negative
// answers `not_found`, the same answer as "no such thing exists", because a
// 403 on someone else's id is an existence oracle: it tells an attacker which
// client ids and key ids are real. panel-survey §5 refusal 5 names this and
// admin-keys.ts:52 already behaves this way for the same reason.
import crypto from "node:crypto";
process.env.SEED_ENCRYPTION_KEY = process.env.SEED_ENCRYPTION_KEY ?? crypto.randomBytes(32).toString("base64");
process.env.PANEL_ENABLED = "1";
process.env.MNTAD_SAMAPAY_HANDOFF_SECRET = "y".repeat(48);
process.env.PANEL_WEBHOOK_ALLOWED_HOSTNAMES = "127.0.0.1";

import { assertSandboxDatabase } from "@/db/guard.js";
import { prisma } from "@/db/client.js";
import { check, summary } from "./lib/check.js";
import { readPanelConfig } from "@/panel/config.js";
import { grantMembership } from "@/panel/accounts.js";
import { panelCreateKey, panelGetKey, panelListKeys, panelRevokeKey, visibleClientIds, PANEL_MINTABLE_SCOPES } from "@/panel/keys.js";
import { panelClearWebhook, panelListDeliveries, panelSetWebhook, panelTestWebhook } from "@/panel/webhook.js";
import { addressesView, auditView, balanceView, depositsView, intentsView } from "@/panel/read-views.js";

const RUN = Date.now().toString(36);
/** A refusal's code, or "ok". Written once so no assertion has to
 *  re-narrow the union every time it wants to say WHY something was refused. */
const codeOf = (r: { ok: boolean }): string => (r.ok ? "ok" : String((r as { code?: string }).code ?? "?"));
const HOOK = "http://127.0.0.1:3090/api/webhooks/samapay/probe";

async function main() {
  console.log(`database: ${await assertSandboxDatabase()}`);
  const cfg = readPanelConfig();
  const a = await prisma.account.create({ data: { email: `iso-a-${RUN}@preview.invalid` } });
  const b = await prisma.account.create({ data: { email: `iso-b-${RUN}@preview.invalid` } });
  const viewer = await prisma.account.create({ data: { email: `iso-v-${RUN}@preview.invalid` } });
  const ca = await prisma.client.create({ data: { name: `iso-client-a-${RUN}`, kind: "merchant" } });
  const cb = await prisma.client.create({ data: { name: `iso-client-b-${RUN}`, kind: "merchant" } });
  await grantMembership({ accountId: a.id, clientId: ca.id, role: "owner" });
  await grantMembership({ accountId: b.id, clientId: cb.id, role: "owner" });
  await grantMembership({ accountId: viewer.id, clientId: ca.id, role: "viewer" });
  try {
    // 0. a fresh account sees nothing until a membership exists
    const orphan = await prisma.account.create({ data: { email: `iso-o-${RUN}@preview.invalid` } });
    const none = await visibleClientIds(orphan.id);
    const blocked = await panelCreateKey({ accountId: orphan.id, clientId: ca.id, name: "nope", scopes: ["deposits.read"], ip: null });
    check(none.length === 0 && !blocked.ok && blocked.code === "not_found",
      "0. an account with no membership cannot mint on any client, and is told nothing exists", JSON.stringify(blocked));
    await prisma.account.delete({ where: { id: orphan.id } });

    // 1. A mints on A
    const mint = await panelCreateKey({ accountId: a.id, clientId: ca.id, name: "gateway", scopes: ["deposits.read", "balance.read"], ip: "203.0.113.7" });
    check(mint.ok && mint.plaintext.startsWith("sk_live_") && mint.row.createdVia === "panel_owner",
      "1. an owner mints on its own client; provenance says panel_owner", `ok=${mint.ok}`);
    if (!mint.ok) throw new Error("mint failed — nothing below this line can be asserted");
    const keyA = mint.id;
    const keyRow = await prisma.clientKey.findUnique({ where: { id: keyA }, select: { createdVia: true, issuedVia: true, keyHash: true, createdFromIp: true } });
    check(keyRow?.keyHash.startsWith("$argon2") === true && !JSON.stringify(keyRow).includes(mint.plaintext),
      "1b. the row holds the argon2 hash of the FULL key and never the plaintext", `hash=${keyRow?.keyHash.slice(0, 9)}`);
    check(keyRow?.issuedVia === "panel_owner" && keyRow?.createdVia === "panel_owner",
      "1c. issuedVia is the PRIVILEGE column: a panel mint must not carry \"cli\", because issueKey's keys.issue refusal is derived from that value", String(keyRow?.issuedVia));

    // 2. B cannot see, read, revoke or reconfigure A's key
    const bList = await panelListKeys(b.id, ca.id);
    const bGet = await panelGetKey(b.id, keyA);
    const bRevoke = await panelRevokeKey({ accountId: b.id, keyId: keyA, reason: "cross-tenant attempt" });
    const bHook = await panelSetWebhook({ accountId: b.id, keyId: keyA, url: HOOK, allowedHostnames: cfg.webhookAllowedHostnames });
    const bClear = await panelClearWebhook({ accountId: b.id, keyId: keyA });
    const bTest = await panelTestWebhook({ accountId: b.id, keyId: keyA });
    check(bList === null && bGet === null && !bRevoke.ok && !bHook.ok && !bClear.ok && !bTest.ok,
      "2. for client A's key, account B gets: not listed, not readable, not revocable, not configurable, not testable",
      [bList === null, bGet === null, codeOf(bRevoke), codeOf(bHook), codeOf(bClear), codeOf(bTest)].join(","));
    const stillActive = await prisma.clientKey.findUnique({ where: { id: keyA }, select: { active: true, webhookUrl: true } });
    check(stillActive?.active === true && stillActive.webhookUrl === null,
      "2b. and every one of those attempts wrote NOTHING — A's key is untouched", JSON.stringify(stillActive));
    const allRefusalsAreNotFound = [bRevoke, bHook, bClear, bTest].every((r) => !r.ok && (r as { code?: string }).code === "not_found");
    check(allRefusalsAreNotFound, "2c. every cross-tenant answer is not_found, never not_owner — no existence oracle", "");

    // 3. reads of B's data by A, and of A's data by B
    const aBalB = await balanceView(a.id, cb.id);
    const bBalA = await balanceView(b.id, ca.id);
    const aDepB = await depositsView(a.id, { clientId: cb.id });
    const aIntB = await intentsView(a.id, { clientId: cb.id });
    const aAddrB = await addressesView(a.id, { clientId: cb.id });
    const aAudB = await auditView(a.id, { clientId: cb.id });
    check("code" in aBalB && "code" in bBalA && aDepB.code === "not_found" && aIntB.code === "not_found" && aAddrB.code === "not_found" && aAudB.code === "not_found",
      "3. balance / deposits / intents / addresses / audit for a foreign client are all not_found", "");

    // 4. a deposit that belongs to A is invisible in B's audit and delivery views
    const addr = await prisma.address.create({ data: { keyId: keyA, clientId: ca.id, reference: `samaprime:${ca.id}:user:iso`, chain: "BEP20", address: `0xiso${RUN.slice(0, 30)}a`, derivationIndex: 900000 + (parseInt(RUN.slice(0, 4), 36) % 90000) } });
    await prisma.deposit.create({
      data: {
        keyId: keyA, clientId: ca.id, addressId: addr.id, chain: "BEP20", txHash: `0xiso${RUN}${"a".repeat(58 - RUN.length)}`,
        amount: "12.5", feeAmount: "0", confirmations: 30, status: "confirmed", blockNumber: 1, detectedAt: new Date(), creditedAt: new Date(),
      },
    });
    // B IS a member of its own client, so "B sees nothing" would be the wrong
    // claim; the isolation claim is that B cannot see A's rows and A's number
    // shows up with its arithmetic visible.
    const aBal = await balanceView(a.id, ca.id);
    const bDepOfA = await depositsView(b.id, { clientId: ca.id });
    const bAddrOfA = await addressesView(b.id, { clientId: ca.id });
    check("chains" in aBal && aBal.chains.BEP20.received === "12.5" && aBal.chains.BEP20.fees === "0" && aBal.chains.BEP20.available === "12.5" && bDepOfA.code === "not_found" && bAddrOfA.code === "not_found",
      "4. A's 12.5 USDT appears in A's own balance as received − fees − withdrawn, and its deposits/addresses are invisible to B",
      JSON.stringify("chains" in aBal ? aBal.chains.BEP20 : aBal));

    // 5. revocation refuses while the key still guards value, and SAYS the number
    const blockedRevoke = await panelRevokeKey({ accountId: a.id, keyId: keyA, reason: "cleanup" });
    check(!blockedRevoke.ok && blockedRevoke.code === "revoke_blocked" && (blockedRevoke as { allowance?: string }).allowance === "12.5",
      "5. the OWNER cannot revoke a key that holds 12.5 either — and the refusal names the allowance", `${codeOf(blockedRevoke)} allowance=${String((blockedRevoke as { allowance?: string }).allowance ?? "")}`);
    await prisma.deposit.deleteMany({ where: { addressId: addr.id } });
    const afterZero = await panelRevokeKey({ accountId: a.id, keyId: keyA, reason: "no value behind it now" });
    check(afterZero.ok === true, "5b. once the value is gone the same revocation succeeds (the guard is specific, not a refusal of everything)", JSON.stringify(afterZero));

    // 6. keys.issue is never mintable from the panel, even if the picker is wrong
    const admin = await panelCreateKey({ accountId: a.id, clientId: ca.id, name: "escalation", scopes: ["keys.issue"], ip: null });
    check(!admin.ok && admin.code === "scope_not_mintable" && admin.scope === "keys.issue",
      "6. an attempt to mint a keys.issue key from the panel is refused by name", `${codeOf(admin)}/${String((admin as { scope?: string }).scope ?? "")}`);
    check(!PANEL_MINTABLE_SCOPES.includes("keys.issue" as never), "6b. and the picker never offered it in the first place", "");

    // 6c-6f. withdrawals are not a panel permission yet (review MEDIUM).
    // `PANEL_MINTABLE_SCOPES` was `SCOPES.filter(s => s !== "keys.issue")`, so
    // every other scope — including the whole withdrawal family — was offered.
    // Withdrawals are UNMOUNTED service-wide in Phase 0 (src/http/app.ts:8-11),
    // so a panel-minted withdrawals.write today is a permission with no route
    // behind it, and the moment the rail is mounted it becomes a key that moves
    // money, minted by a browser session with no step-up. The rail's own review
    // (the "keys that can move money need a second factor at use" ruling) is
    // what has to land before either half comes back.
    const keysBeforeAttempts = await prisma.clientKey.count({ where: { clientId: ca.id } });
    const wWrite = await panelCreateKey({ accountId: a.id, clientId: ca.id, name: "withdraw-writer", scopes: ["withdrawals.write"], ip: null });
    check(!wWrite.ok && wWrite.code === "scope_not_mintable" && wWrite.scope === "withdrawals.write",
      "6c. withdrawals.write is refused from the panel BY NAME, the same way keys.issue is", `${codeOf(wWrite)}/${String((wWrite as { scope?: string }).scope ?? "")}`);
    const wRead = await panelCreateKey({ accountId: a.id, clientId: ca.id, name: "withdraw-reader", scopes: ["withdrawals.read"], ip: null });
    check(!wRead.ok && wRead.code === "scope_not_mintable",
      "6d. the whole family goes, not just the write half — a panel that offers `withdrawals.read` advertises a surface that does not exist",
      `${codeOf(wRead)}/${String((wRead as { scope?: string }).scope ?? "")}`);
    const wMixed = await panelCreateKey({ accountId: a.id, clientId: ca.id, name: "mixed", scopes: ["deposits.read", "withdrawals.write"], ip: null });
    const keysAfterAttempts = await prisma.clientKey.count({ where: { clientId: ca.id } });
    check(!wMixed.ok && wMixed.code === "scope_not_mintable" && keysAfterAttempts === keysBeforeAttempts,
      "6e. a MIXED request naming one good scope and one bad is refused whole, and writes no key row (no partial mint to discover later)",
      `${codeOf(wMixed)} keys=${keysBeforeAttempts}→${keysAfterAttempts}`);
    const offered = PANEL_MINTABLE_SCOPES.filter((s) => /^(withdrawals|keys)\./.test(s));
    check(offered.length === 0 && PANEL_MINTABLE_SCOPES.includes("deposits.read" as never) && PANEL_MINTABLE_SCOPES.includes("payment_intents.write" as never),
      "6f. the picker offers neither family AND still offers the merchant's real scopes — the fix is a narrowing, not a shut door",
      `excluded=${JSON.stringify(offered)}`);

    // 7. a viewer reads but never mutates
    const vList = await panelListKeys(viewer.id, ca.id);
    const vMint = await panelCreateKey({ accountId: viewer.id, clientId: ca.id, name: "viewer key", scopes: ["deposits.read"], ip: null });
    const vHook = await panelSetWebhook({ accountId: viewer.id, keyId: (vList?.[0]?.id ?? "x"), url: HOOK, allowedHostnames: cfg.webhookAllowedHostnames });
    check(vList !== null && !vMint.ok && vMint.code === "not_owner" && !vHook.ok && vHook.code === "not_owner",
      "7. a viewer sees the keys and can change none of it (read-only by role, not by UI hiding)", `list=${vList?.length} mint=${codeOf(vMint)}/${codeOf(vHook)}`);

    // 8. the audit view is the client's own rows plus the caller's own actions, never a foreign cli row
    await grantMembership({ accountId: b.id, clientId: ca.id, role: "viewer" });
    const aAudit = await auditView(a.id, { clientId: ca.id });
    const foreignActor = (aAudit.code === "ok" ? aAudit.rows : []).some((r) => r.actor === `account:${b.id}` && r.action === "nope");
    check(aAudit.code === "ok" && aAudit.rows.some((r) => r.actor === `account:${a.id}`) && !foreignActor,
      "8. A's audit shows A's own panel actions and the rows about A's keys; it never leaks another account's rows", `rows=${aAudit.code === "ok" ? aAudit.rows.length : 0}`);
    const cliRow = await prisma.auditEvent.create({ data: { actor: "cli:ibrahim", action: "key.issued", keyId: keyA, prevHash: "f".repeat(64), hash: crypto.randomUUID().replace(/-/g, "") + "0".repeat(26) } });
    const aAudit2 = await auditView(a.id, { clientId: ca.id });
    const bAudit2 = await auditView(b.id, { clientId: cb.id });
    const inA = (aAudit2.code === "ok" ? aAudit2.rows : []).some((r) => r.id === cliRow.id);
    const inB = (bAudit2.code === "ok" ? bAudit2.rows : []).some((r) => r.id === cliRow.id);
    check(inA === true && inB === false, "8b. a cli:ibrahim row appears ONLY to the account whose key it names", `inA=${inA} inB=${inB}`);

    // 9. deliveries are per client. B was made a VIEWER of A's client in
    // assertion 8, so the "must not be visible" half needs an account with no
    // membership at all — otherwise this test would pass on a bug.
    const stranger = await prisma.account.create({ data: { email: `iso-s-${RUN}@preview.invalid` } });
    const dlStranger = await panelListDeliveries({ accountId: stranger.id, clientId: ca.id });
    const dlB = await panelListDeliveries({ accountId: b.id, clientId: cb.id });
    const dlOwn = await panelListDeliveries({ accountId: a.id, clientId: ca.id });
    check(dlStranger === null && Array.isArray(dlB) && Array.isArray(dlOwn),
      "9. the delivery log is scoped the same way: no membership → null, own client → a list", JSON.stringify({ stranger: dlStranger === null, b: Array.isArray(dlB), a: Array.isArray(dlOwn) }));
    const dlViewerAllowed = await panelListDeliveries({ accountId: viewer.id, clientId: ca.id });
    check(Array.isArray(dlViewerAllowed), "9b. a viewer may READ the delivery log — read-only is a role, not a lockout", "");
  } finally {
    await prisma.auditEvent.deleteMany({ where: { key: { client: { id: { in: [ca.id, cb.id] } } } } });
    await prisma.deposit.deleteMany({ where: { key: { client: { id: { in: [ca.id, cb.id] } } } } });
    await prisma.address.deleteMany({ where: { clientId: { in: [ca.id, cb.id] } } });
    await prisma.clientKey.deleteMany({ where: { clientId: { in: [ca.id, cb.id] } } });
    await prisma.accountClient.deleteMany({ where: { accountId: { in: [a.id, b.id, viewer.id] } } });
    await prisma.panelSession.deleteMany({ where: { accountId: { in: [a.id, b.id, viewer.id] } } });
    await prisma.account.deleteMany({ where: { id: { in: [a.id, b.id, viewer.id] } } });
    await prisma.client.deleteMany({ where: { id: { in: [ca.id, cb.id] } } });
  }
  const failed = summary();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
