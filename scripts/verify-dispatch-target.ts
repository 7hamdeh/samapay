// COVERS: src/webhooks/dispatch.ts src/panel/keys.ts src/panel/webhook.ts src/events/index.ts
//
// =====================================================================
// *** WHICH KEY'S WEBHOOK URL DOES A DELIVERY GO TO? ***
// =====================================================================
// pay-dashboard review 2026-09-27, HIGH (money path, probe-proven).
//
// Contract v1.1 A6 was implemented as "the client's current active key,
// NEWEST FIRST" (src/webhooks/dispatch.ts:137-140 at 7c35686). Read literally
// that is one rule for every delivery of a client, and a client is not always
// one store: `Client` is the MNTAD account and several merchant keys share it
// (CLAUDE.md decision #80). So the moment the panel let an owner mint a key
// with a webhook (panel/keys.ts:112-127) or set one (panel/webhook.ts:33-58),
// EVERY pending event of that client — including the `deposit.confirmed` rows
// that credit a store — began arriving at the newest key's URL, signed with
// the newest key's secret. The store that was paid for stops being credited
// until reconcile + redrive notice. The reviewer's probe measured it:
// "AFTER panel mint: event of the STORE's key posted to
// http://127.0.0.1:9/owner-chosen-receiver".
//
// WHAT A6 WAS ACTUALLY FOR: a ROTATION. An address and its money stay on the
// old key forever (revocation refuses while value sits behind it), so the old
// key's events must still arrive, signed with the secret the receiver holds
// NOW. That need is about a key that can no longer receive — not a licence to
// ignore the key a delivery belongs to while it is still active.
//
// So the rule under test is: **the delivery's own key while it is active and
// still carries a webhook target; the client's newest active key only as the
// fallback once the own key is revoked, deactivated, or has no target of its
// own.** Every case below is written so that BOTH directions are asserted —
// the narrowing (a delivery stays home) and the preserved fallback (a rotated
// delivery moves) — because a fix that only ever uses the own key would pass
// the HIGH and break A6, which is the money path in the other direction.
//
// Throwaway only: SEED_ENCRYPTION_KEY is generated in this process, the stub
// receiver is a local HTTP server on a random port, no chain is touched and no
// real key or .env is read.
//
//   bash <throwaway-pg.sh> ./node_modules/.bin/tsx scripts/throwaway-sandbox.ts \
//     scripts/verify-dispatch-target.ts
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

process.env.SEED_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.PANEL_ENABLED = "1";
process.env.MNTAD_SAMAPAY_HANDOFF_SECRET = "y".repeat(48);
// Operator config, exactly as a deployment that wants a loopback receiver sets
// it. It is the ONLY thing that opens the plain-http door, and it is never
// merchant input (src/net/webhook-target.ts header).
process.env.PANEL_WEBHOOK_ALLOWED_HOSTNAMES = "127.0.0.1";

import { Prisma } from "@prisma/client";
import { assertSandboxDatabase } from "@/db/guard.js";
import { prisma } from "@/db/client.js";
import { issueKey } from "@/keys/issue.js";
import { grantMembership } from "@/panel/accounts.js";
import { panelCreateKey } from "@/panel/keys.js";
import { panelTestWebhook } from "@/panel/webhook.js";
import * as dispatch from "@/webhooks/dispatch.js";
import * as sign from "@/webhooks/sign.js";
import * as events from "@/events/index.js";
import { check, summary } from "./lib/check.js";

const RUN = Date.now().toString(36);
const MIN = 60_000;

/** What the stub receiver actually saw: the path it was POSTed to, and whether
 *  the signature verifies against the secret of the key we expected. */
type Hit = { path: string; body: string; signature: string };

async function main() {
  console.log(`database: ${await assertSandboxDatabase()}`);

  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString("utf8"); });
    req.on("end", () => {
      hits.push({ path: req.url ?? "", body, signature: String(req.headers["x-samapay-signature"] ?? "") });
      res.statusCode = 200;
      res.end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const urlFor = (label: string) => `http://127.0.0.1:${port}/${label}`;

  // A deposit arriving on `key` is enough to make a real deposit.confirmed:
  // this suite is about WHERE it goes, and that must be proven on the event
  // that credits a store, not on a synthetic type.
  let idx = 7_000_000 + Math.floor(Math.random() * 50_000);
  const client = await prisma.client.create({ data: { name: `dsp-target-${RUN}`, kind: "merchant" } });
  const mkDeposit = async (keyId: string, reference: string) => {
    const address = await prisma.address.create({
      data: { keyId, clientId: client.id, reference, chain: "TRC20", address: `T${RUN}${idx}`.padEnd(34, "x"), derivationIndex: idx++ },
      select: { id: true, address: true },
    });
    const deposit = await prisma.deposit.create({
      data: { keyId, addressId: address.id, chain: "TRC20", txHash: `0x${crypto.randomBytes(32).toString("hex")}`, amount: new Prisma.Decimal("5"), confirmations: 20, status: "confirmed", blockNumber: 1n, creditedAt: new Date() },
      select: { id: true, txHash: true },
    });
    const snapshot = {
      id: `dep_${deposit.id}`, object: "deposit", status: "confirmed", chain: "TRC20", tx_hash: deposit.txHash,
      amount: "5", confirmations: 20, address: address.address, reference, payment_intent_id: null,
      detected_at: new Date().toISOString(), confirmed_at: new Date().toISOString(),
    };
    const out = await prisma.$transaction((tx) => events.enqueueEvent(tx, { type: "deposit.confirmed", objectKind: "deposit", objectId: snapshot.id, snapshot }));
    return out.status === "suppressed" ? null : out.deliveryId;
  };

  /** Deliver one fresh deposit of `keyId` and report where it landed. */
  const deliver = async (keyId: string, reference: string): Promise<{ outcome: string; hit: Hit | null }> => {
    const deliveryId = await mkDeposit(keyId, reference);
    if (!deliveryId) return { outcome: "suppressed", hit: null };
    hits.length = 0;
    const out = await dispatch.attemptDelivery(deliveryId);
    return { outcome: out.outcome, hit: hits[0] ?? null };
  };

  const store = await issueKey({ clientId: client.id, name: "store-key", scopes: ["deposits.read", "events.read"], issuedBy: "ibrahim", issuedVia: "cli", webhookUrl: urlFor("store") });
  const storeSecret = store.webhookSecret ?? "";
  const madeKeys = [store.id];

  try {
    // ── 1. the baseline: one key, one target ────────────────────────────────
    const before = await deliver(store.id, `samaprime:m${RUN}:before`);
    check(before.outcome === "delivered" && before.hit?.path === "/store" && sign.verifySignature(storeSecret, before.hit.body, before.hit.signature),
      "1. with one key on the client, its deposit.confirmed reaches that key's URL, signed with that key's secret",
      `outcome=${before.outcome} path=${before.hit?.path}`);

    // ── 2. THE HIGH: a panel-minted key must not capture the store's events ─
    const account = await prisma.account.create({ data: { email: `dsp-${RUN}@preview.invalid` } });
    await grantMembership({ accountId: account.id, clientId: client.id, role: "owner" });
    const minted = await panelCreateKey({ accountId: account.id, clientId: client.id, name: "owner-key", scopes: ["deposits.read"], webhookUrl: urlFor("owner"), ip: null, allowedHostnames: ["127.0.0.1"] });
    check(minted.ok, "2. the owner CAN mint a second key with its own webhook on this client (the panel's legitimate job)", `ok=${minted.ok}`);
    if (!minted.ok) throw new Error("panel mint refused — nothing below this line can be asserted");
    madeKeys.push(minted.id);

    const after = await deliver(store.id, `samaprime:m${RUN}:after`);
    check(after.outcome === "delivered" && after.hit?.path === "/store",
      "2b. HIGH — and the STORE key's next deposit still goes to the store URL, not to the newest key's",
      `outcome=${after.outcome} path=${after.hit?.path ?? "(no POST)"}`);
    check(!!after.hit && sign.verifySignature(storeSecret, after.hit.body, after.hit.signature),
      "2c. …signed with the STORE key's secret (a delivery signed with the new key's secret is the reroute, seen from the receiver)",
      `signed=${!!after.hit}`);
    // CONTROL: the two paths are distinguishable, so 2b is not passing because
    // nothing arrives at all. The panel key's own event MUST land on /owner.
    const mine = await deliver(minted.id, `samaprime:m${RUN}:owner`);
    check(mine.outcome === "delivered" && mine.hit?.path === "/owner" && !!mine.hit && sign.verifySignature(minted.webhookSecret ?? "", mine.hit.body, mine.hit.signature),
      "2d. CONTROL — the new key's OWN deposit goes to /owner, which is what makes 2b/2c a real discrimination",
      `outcome=${mine.outcome} path=${mine.hit?.path ?? "(no POST)"}`);

    // ── 3. the two-key check the review asked for, on a SHARED client ──────
    const store2 = await issueKey({ clientId: client.id, name: "store-key-2", scopes: ["deposits.read"], issuedBy: "ibrahim", issuedVia: "cli", webhookUrl: urlFor("store2") });
    madeKeys.push(store2.id);
    const a = await deliver(store.id, `samaprime:m${RUN}:shared-a`);
    const b = await deliver(store2.id, `samaprime:m${RUN}:shared-b`);
    const c = await deliver(minted.id, `samaprime:m${RUN}:shared-c`);
    check(a.hit?.path === "/store" && b.hit?.path === "/store2" && c.hit?.path === "/owner",
      "3. THREE active keys, one client: each key's deposit.confirmed goes to its OWN URL — a second store on a shared client is never rerouted by a newer key",
      [a.hit?.path, b.hit?.path, c.hit?.path].join(" | "));

    // ── 4. A6's real purpose survives: a rotated delivery still moves ──────
    // Revocation refuses while value sits behind a key, so an address (and the
    // deliveries hanging off it) outlives the key on purpose. With the own key
    // gone, the client's newest active target takes over — signed with the
    // secret the receiver holds NOW. Narrowing the rule must not break this.
    const successor = await issueKey({ clientId: client.id, name: "successor", scopes: ["deposits.read"], issuedBy: "ibrahim", issuedVia: "cli", webhookUrl: urlFor("successor") });
    madeKeys.push(successor.id);
    await prisma.clientKey.update({ where: { id: store2.id }, data: { active: false, revokedAt: new Date(), revokedReason: "rotated", successorKeyId: successor.id } });
    // An address cannot move off the revoked key, so a NEW deposit on it is the
    // only way to make a due delivery whose own key is the revoked one.
    const rotatedRef = `samaprime:m${RUN}:rotated`;
    const rotatedAddress = await prisma.address.create({
      data: { keyId: store2.id, clientId: client.id, reference: rotatedRef, chain: "TRC20", address: `T${RUN}${idx}`.padEnd(34, "x"), derivationIndex: idx++ },
      select: { id: true, address: true },
    });
    const rotatedDeposit = await prisma.deposit.create({
      data: { keyId: store2.id, addressId: rotatedAddress.id, chain: "TRC20", txHash: `0x${crypto.randomBytes(32).toString("hex")}`, amount: new Prisma.Decimal("5"), confirmations: 20, status: "confirmed", blockNumber: 1n, creditedAt: new Date() },
      select: { id: true, txHash: true },
    });
    const rotatedEvent = await prisma.$transaction((tx) => events.enqueueEvent(tx, {
      type: "deposit.confirmed", objectKind: "deposit", objectId: `dep_${rotatedDeposit.id}`,
      snapshot: { id: `dep_${rotatedDeposit.id}`, object: "deposit", status: "confirmed", chain: "TRC20", tx_hash: rotatedDeposit.txHash, amount: "5", confirmations: 20, address: rotatedAddress.address, reference: rotatedRef, payment_intent_id: null, detected_at: new Date().toISOString(), confirmed_at: new Date().toISOString() },
    }));
    hits.length = 0;
    const rotOut = rotatedEvent.status === "suppressed" ? { outcome: "suppressed" } : await dispatch.attemptDelivery(rotatedEvent.deliveryId);
    const rotHit = hits[0] ?? null;
    check(rotOut.outcome === "delivered" && rotHit?.path === "/successor" && !!rotHit && sign.verifySignature(successor.webhookSecret ?? "", rotHit.body, rotHit.signature) && !sign.verifySignature(store2.webhookSecret ?? "", rotHit.body, rotHit.signature),
      "4. A6 SURVIVES the narrowing: a delivery whose own key is revoked goes to the client's newest active key and is signed with THAT secret",
      `outcome=${rotOut.outcome} path=${rotHit?.path ?? "(no POST)"}`);
    check(rotOut.outcome !== "suppressed" && rotOut.outcome !== "retry", "4b. CONTROL — it really was sent, not merely refused", String(rotOut.outcome));

    // ── 5. and the other half of the fallback: an ACTIVE key with no target ─
    const orphan = await issueKey({ clientId: client.id, name: "no-webhook", scopes: ["deposits.read"], issuedBy: "ibrahim", issuedVia: "cli" });
    madeKeys.push(orphan.id);
    const noTarget = await deliver(orphan.id, `samaprime:m${RUN}:orphan`);
    check(noTarget.outcome === "delivered" && noTarget.hit?.path === "/successor",
      "5. an active key that carries NO webhook still falls back to the client's newest active target (A6, the no-rotation case)",
      `outcome=${noTarget.outcome} path=${noTarget.hit?.path ?? "(no POST)"}`);
    // Clearing a target moves the same way: the key is active but has nowhere
    // to send, so its events join the client's current receiver.
    const temp = await issueKey({ clientId: client.id, name: "temp-target", scopes: ["deposits.read"], issuedBy: "ibrahim", issuedVia: "cli", webhookUrl: urlFor("temp") });
    madeKeys.push(temp.id);
    const heldSecret = (await prisma.clientKey.findUniqueOrThrow({ where: { id: temp.id }, select: { webhookSecret: true } })).webhookSecret;
    await prisma.clientKey.update({ where: { id: temp.id }, data: { webhookUrl: null, webhookSecret: null, webhookUpdatedAt: new Date() } });
    const cleared = await deliver(temp.id, `samaprime:m${RUN}:cleared`);
    check(cleared.outcome === "delivered" && cleared.hit?.path === "/successor",
      "5b. …and so does an active key whose webhook was just cleared", `outcome=${cleared.outcome} path=${cleared.hit?.path ?? "(no POST)"}`);
    await prisma.clientKey.update({ where: { id: temp.id }, data: { webhookUrl: urlFor("temp"), webhookSecret: heldSecret } });
    const restored = await deliver(temp.id, `samaprime:m${RUN}:restored`);
    check(restored.outcome === "delivered" && restored.hit?.path === "/temp",
      "5c. CONTROL — put the target back and the delivery comes home, which proves 5b was the missing target and not the key",
      `outcome=${restored.outcome} path=${restored.hit?.path ?? "(no POST)"}`);

    // ── 6. the panel's test button: the row it writes belongs to THAT key ──
    // The review's MEDIUM on dispatch-time SSRF leaned on the same defect: the
    // test button re-guarded key X's URL and then `attemptDelivery` POSTed the
    // row to the newest key's URL, so the guard judged one address and the
    // transport used another. This asserts the two are now the same address.
    hits.length = 0;
    const test = await panelTestWebhook({ accountId: account.id, keyId: minted.id, allowedHostnames: ["127.0.0.1"] });
    check(test.ok && hits.length === 1 && hits[0]?.path === "/owner",
      "6. a panel test-send on key X is POSTed to key X's URL — the URL the guard judged, not the client's newest",
      `ok=${test.ok} posts=${hits.length} path=${hits[0]?.path ?? "(none)"}`);
    const otherTest = await panelTestWebhook({ accountId: account.id, keyId: store.id, allowedHostnames: ["127.0.0.1"] });
    check(otherTest.ok && hits.at(-1)?.path === "/store",
      "6b. …and a test on the store key goes to the STORE url, which is the case that used to be aimed at the newest key",
      `ok=${otherTest.ok} path=${hits.at(-1)?.path ?? "(none)"}`);

    // ── 7. the schedule is unchanged by the narrowing ──────────────────────
    // A failed attempt must retry against the SAME (own) key, or the fix would
    // have moved money mid-retry, which is the defect in a slower costume.
    const retryKey = await issueKey({ clientId: client.id, name: "retry", scopes: ["deposits.read"], issuedBy: "ibrahim", issuedVia: "cli", webhookUrl: urlFor("retry") });
    madeKeys.push(retryKey.id);
    const retryDeliveryId = await mkDeposit(retryKey.id, `samaprime:m${RUN}:retry`);
    if (!retryDeliveryId) throw new Error("no delivery for the retry case");
    await prisma.webhookDelivery.update({ where: { id: retryDeliveryId }, data: { attempts: 1, status: "pending", nextAttemptAt: new Date() } });
    hits.length = 0;
    const retry1 = await dispatch.attemptDelivery(retryDeliveryId);
    const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: retryDeliveryId }, select: { status: true, attempts: true, nextAttemptAt: true } });
    check(retry1.outcome === "delivered" && hits[0]?.path === "/retry" && row.status === "delivered",
      "7. the retry path re-reads the SAME key on the next attempt (the target is a property of the delivery, not of the moment)",
      `outcome=${retry1.outcome} path=${hits[0]?.path ?? "(none)"} status=${row.status}`);
    // An attempt that is not due yet is not sent at all — the lease still holds.
    await prisma.webhookDelivery.update({ where: { id: retryDeliveryId }, data: { status: "pending", attempts: 2, nextAttemptAt: new Date(Date.now() + MIN) } });
    hits.length = 0;
    const notDue = await dispatch.attemptDelivery(retryDeliveryId);
    check(notDue.outcome === "not_claimed" && hits.length === 0, "7b. CONTROL — a row that is not due is not claimed and not POSTed", `outcome=${notDue.outcome} posts=${hits.length}`);
  } finally {
    const clientIds = { in: [client.id] };
    await prisma.webhookDelivery.deleteMany({ where: { clientId: clientIds } });
    await prisma.event.deleteMany({ where: { clientId: clientIds } });
    await prisma.deposit.deleteMany({ where: { key: { clientId: client.id } } });
    await prisma.address.deleteMany({ where: { clientId: client.id } });
    await prisma.auditEvent.deleteMany({ where: { key: { client: { id: client.id } } } });
    const accounts = await prisma.account.findMany({ where: { email: `dsp-${RUN}@preview.invalid` }, select: { id: true } });
    const accountIds = { in: accounts.map((r) => r.id) };
    await prisma.panelBackupCode.deleteMany({ where: { accountId: accountIds } });
    await prisma.panelSession.deleteMany({ where: { accountId: accountIds } });
    await prisma.clientKey.deleteMany({ where: { clientId: client.id } });
    await prisma.accountClient.deleteMany({ where: { clientId: client.id } });
    await prisma.account.deleteMany({ where: { id: accountIds } });
    await prisma.client.deleteMany({ where: { id: client.id } });
    const left = await prisma.clientKey.count({ where: { clientId: client.id } }) + await prisma.client.count({ where: { id: client.id } });
    if (left !== 0) console.log(`  (cleanup: ${left} row(s) pinned by the audit trail and left in place)`);
    server.close();
    await prisma.$disconnect();
  }
  process.exit(summary());
}
main().catch((e) => { console.error("verify-dispatch-target crashed:", e); process.exit(1); });
