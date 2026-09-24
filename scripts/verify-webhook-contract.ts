// COVERS: src/webhooks/dispatch.ts src/webhooks/sign.ts src/webhooks/redrive.ts src/events/envelope.ts src/events/index.ts scripts/ops/redrive-deliveries.ts
//
// Phase 0, G3 — the webhook + event contract (/root/pay-mntad-api-contract.md
// §4 Event, §7 Webhooks), RED-FIRST. Every check is observed from the
// RECEIVER's side where one exists: a local stub HTTP server on 127.0.0.1
// receives the delivery, and the contract's receiver algorithm (sign.ts
// verifySignature) is what judges the signature.
//
//   A. signing: receiver verifies; stale t refused; multi-v1 (rotation)
//   B. headers + envelope on a real HTTP delivery (decrypted secret, 11437a3)
//   C. retry schedule 1m,5m,30m,2h,6h,12h,24h, then exhausted, then silence
//   D. the 10 s timeout, against a receiver that never answers
//   E. enqueueEvent exactly once under concurrency (one event, one delivery)
//   F. deposit.confirmed for EVERY confirmed deposit, intent addresses included
//      (contract v1.1 A1), except watch-disabled addresses and legacy_import
//      addresses on a chain SamaPay does not watch yet (lead, 2026-09-24)
//   G. getEvent: the owner reads it; another client gets nothing
//   H. dispatch goes to the client's CURRENT active key (v1.1 A6)
//   I. the delivery claim: two workers never send the same attempt (v1.1 A7)
//   J. redrive: exhausted deliveries re-queued, dry run by default (v1.1 A5/A9)
//
// Throwaway only: SEED_ENCRYPTION_KEY is generated in this process; no real
// key, seed or .env is read; no chain is touched.
import crypto from "node:crypto";
import http from "node:http";
import { spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
process.env.SEED_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

import { Prisma } from "@prisma/client";
import { assertSandboxDatabase } from "@/db/guard.js";
import { prisma } from "@/db/client.js";
import { issueKey } from "@/keys/issue.js";
import * as dispatch from "@/webhooks/dispatch.js";
import * as sign from "@/webhooks/sign.js";
import { check, summary } from "./lib/check.js";

const RUN = Date.now().toString(36);
// Key-order-independent equality: the payload is stored as jsonb, which keeps
// content but not key order. The signature is over the bytes actually SENT.
const canon = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x));
const MIN = 60_000, H = 60 * MIN;
const CONTRACT_SCHEDULE = [1 * MIN, 5 * MIN, 30 * MIN, 2 * H, 6 * H, 12 * H, 24 * H];

// The events module is NEW in this unit. Loaded dynamically so that on the
// old code the pure sections still run and fail for their own reasons instead
// of the whole suite dying on one import.
type EventsModule = typeof import("@/events/index.js");
async function loadEvents(): Promise<EventsModule | null> {
  try { return await import("@/events/index.js"); } catch (e) { console.log(`  (events module not loadable: ${(e as Error).message.slice(0, 120)})`); return null; }
}
type RedriveModule = typeof import("@/webhooks/redrive.js");
async function loadRedrive(): Promise<RedriveModule | null> {
  try { return await import("@/webhooks/redrive.js"); } catch (e) { console.log(`  (redrive module not loadable: ${(e as Error).message.slice(0, 120)})`); return null; }
}

// ── the stub receiver ───────────────────────────────────────────────────────
interface Received { url: string; headers: http.IncomingHttpHeaders; body: string; at: number }
let mode: "ok" | "fail" | "hang" | "slow" = "ok";
const received: Received[] = [];
const hanging: http.ServerResponse[] = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c: Buffer) => { body += c.toString("utf8"); });
  req.on("end", () => {
    received.push({ url: req.url ?? "", headers: req.headers, body, at: Date.now() });
    if (mode === "hang") { hanging.push(res); return; }
    if (mode === "slow") { setTimeout(() => { res.statusCode = 200; res.end("slow"); }, 700); return; }
    res.statusCode = mode === "ok" ? 200 : 500;
    res.end(mode);
  });
});

async function main() {
  console.log(`database: ${await assertSandboxDatabase()}`);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const hook = `http://127.0.0.1:${port}/hook`;
  const events = await loadEvents();
  const redrive = await loadRedrive();
  const testStart = new Date();

  // ── A. signing (pure) ────────────────────────────────────────────────────
  const secret = "whsec_" + "a".repeat(43), rotated = "whsec_" + "b".repeat(43);
  const body = JSON.stringify({ id: "evt_x", object: "event", type: "deposit.confirmed" });
  const now = 1_800_000_000;
  const one = sign.signPayload(secret, body, now);
  check(sign.verifySignature(secret, body, one, now), "A1. the receiver algorithm verifies a signature made by the signer");
  check(!sign.verifySignature(secret, body, one, now + 301), "A2. CONTROL — stale t (|now − t| = 301 s) is rejected by the receiver helper");
  check(!sign.verifySignature(secret, body, one, now - 301), "A2b. CONTROL — a t 301 s in the FUTURE is rejected too");
  const signMulti = sign.signPayload as unknown as (s: string | readonly string[], b: string, t?: number) => string;
  let both = "";
  try { both = signMulti([rotated, secret], body, now); } catch (e) { both = `THREW ${(e as Error).message}`; }
  const v1Count = (both.match(/v1=[0-9a-f]{64}/g) ?? []).length;
  check(v1Count === 2 && both.startsWith(`t=${now},`), "A3. rotation: the signer emits one v1 per secret in ONE header", both.slice(0, 40) + "…");
  check(sign.verifySignature(secret, body, both, now) && sign.verifySignature(rotated, body, both, now), "A4. rotation: a receiver holding EITHER secret accepts the multi-v1 header");
  check(!sign.verifySignature("whsec_" + "c".repeat(43), body, both, now), "A5. CONTROL — a receiver holding neither secret rejects it");
  const junkFirst = `t=${now},v1=${"0".repeat(64)},v1=${one.split("v1=")[1]}`;
  check(sign.verifySignature(secret, body, junkFirst, now), "A6. a wrong v1 before the right one does not hide the right one (any v1 in the list)");
  const verifyMulti = sign.verifySignature as unknown as (s: string | readonly string[], b: string, h: string, n?: number) => boolean;
  let recvBoth = false;
  try { recvBoth = verifyMulti([rotated, secret], body, one, now); } catch { recvBoth = false; }
  check(recvBoth, "A7. rotation, receiver side: a receiver holding [new, old] accepts a header signed with old only");
  check(!sign.verifySignature(secret, body, `t=${now},t=${now - 1000},v1=${one.split("v1=")[1]}`, now), "A8. CONTROL — two t= parts are refused (no choosing the fresher one)");
  check(!sign.verifySignature(secret, body.replace("evt_x", "evt_y"), both, now), "A9. CONTROL — one changed body byte fails every v1");

  // fixtures
  const clientA = await prisma.client.create({ data: { name: `g3-a-${RUN}`, kind: "merchant" }, select: { id: true } });
  const clientB = await prisma.client.create({ data: { name: `g3-b-${RUN}`, kind: "merchant" }, select: { id: true } });
  const keyA = await issueKey({ clientId: clientA.id, name: "a", scopes: ["deposits.read"], issuedBy: "verify", issuedVia: "cli", webhookUrl: hook });
  const plainSecret = keyA.webhookSecret ?? "";
  let idx = 900_000 + Math.floor(Math.random() * 50_000);
  const mkAddress = async (reference: string) => prisma.address.create({ data: { keyId: keyA.id, reference, chain: "TRC20", address: `T${RUN}${idx}`.padEnd(34, "x"), derivationIndex: idx++ }, select: { id: true, address: true } });
  const mkDeposit = async (addressId: string) => prisma.deposit.create({ data: { keyId: keyA.id, addressId, chain: "TRC20", txHash: `0x${crypto.randomBytes(32).toString("hex")}`, amount: new Prisma.Decimal("5"), confirmations: 20, status: "confirmed", blockNumber: 1n, creditedAt: new Date() }, select: { id: true, txHash: true } });
  const depSnapshot = (id: string, txHash: string, address: string, reference: string, paymentIntentId: string | null = null) => ({ id: `dep_${id}`, object: "deposit", status: "confirmed", chain: "TRC20", tx_hash: txHash, amount: "5", confirmations: 20, address, reference, payment_intent_id: paymentIntentId, detected_at: new Date().toISOString(), confirmed_at: new Date().toISOString() });
  const enqueueDeposit = async (addr: { id: string; address: string }, reference: string, paymentIntentId: string | null = null) => {
    const d = await mkDeposit(addr.id);
    const snap = depSnapshot(d.id, d.txHash, addr.address, reference, paymentIntentId);
    const out = events ? await prisma.$transaction((tx) => events.enqueueEvent(tx, { type: "deposit.confirmed", objectKind: "deposit", objectId: snap.id, snapshot: snap })) : null;
    return { d, snap, out, deliveryId: out && out.status !== "suppressed" ? out.deliveryId : null };
  };
  const makeDue = (id: string) => prisma.webhookDelivery.update({ where: { id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
  const eventsFor = (objectId: string) => (prisma as unknown as { event: { count(a: unknown): Promise<number> } }).event.count({ where: { objectId } }).catch(() => -1);

  try {
    // ── B. headers + envelope over real HTTP ─────────────────────────────────
    const plain = await mkAddress(`samaprime:m1:user:u1`);
    const dep = await mkDeposit(plain.id);
    const snap = depSnapshot(dep.id, dep.txHash, plain.address, "samaprime:m1:user:u1");
    let enq: Awaited<ReturnType<EventsModule["enqueueEvent"]>> | null = null;
    if (events) enq = await prisma.$transaction((tx) => events.enqueueEvent(tx, { type: "deposit.confirmed", objectKind: "deposit", objectId: snap.id, snapshot: snap }));
    check(!!enq && enq.status === "created" && /^evt_[A-Za-z0-9]{24,}$/.test(enq.eventId), "B1. enqueueEvent on a plain top-up address creates an evt_ event", JSON.stringify(enq));
    const deliveryId = enq && enq.status !== "suppressed" ? enq.deliveryId : null;
    const enqEventId = enq && enq.status !== "suppressed" ? enq.eventId : null;
    mode = "ok"; received.length = 0;
    const out = deliveryId ? await dispatch.attemptDelivery(deliveryId) : { outcome: "none" };
    const got = received[0];
    check(out.outcome === "delivered" && received.length === 1, "B2. one real HTTP POST reached the stub and was marked delivered", `outcome=${out.outcome} posts=${received.length}`);
    const h = got?.headers ?? {};
    check(h["content-type"] === "application/json", "B3. Content-Type: application/json", String(h["content-type"]));
    check(h["x-samapay-event"] === "deposit.confirmed", "B4. X-SamaPay-Event names the type", String(h["x-samapay-event"]));
    check(!!deliveryId && h["x-samapay-delivery"] === deliveryId, "B5. X-SamaPay-Delivery carries the delivery id", String(h["x-samapay-delivery"]));
    check(!!got && sign.verifySignature(plainSecret, got.body, String(h["x-samapay-signature"])), "B6. X-SamaPay-Signature verifies with the PLAINTEXT secret over the RAW body (11437a3 kept)");
    const env = JSON.parse(got?.body ?? "{}") as Record<string, unknown> & { data?: { object?: Record<string, unknown> } };
    check(env.id === enqEventId && env.object === "event" && env.api_version === "2026-09-24" && env.type === "deposit.confirmed" && typeof env.created_at === "string" && /Z$/.test(String(env.created_at)), "B7. body is the §4 envelope: id, object, api_version 2026-09-24, type, ISO created_at", JSON.stringify(env).slice(0, 140));
    check(canon(env.data?.object) === canon(snap), "B8. data.object is the snapshot exactly as enqueued");

    // ── C. retry schedule ───────────────────────────────────────────────────
    const plain2 = await mkAddress(`samaprime:m1:user:u2`);
    const dep2 = await mkDeposit(plain2.id);
    const snap2 = depSnapshot(dep2.id, dep2.txHash, plain2.address, "samaprime:m1:user:u2");
    const enq2 = events ? await prisma.$transaction((tx) => events.enqueueEvent(tx, { type: "deposit.confirmed", objectKind: "deposit", objectId: snap2.id, snapshot: snap2 })) : null;
    const d2 = enq2 && enq2.status !== "suppressed" ? enq2.deliveryId : null;
    mode = "fail"; received.length = 0;
    const delays: number[] = [];
    let last: { outcome: string } = { outcome: "none" };
    if (d2) {
      for (let i = 0; i < 8; i++) {
        if (i > 0) await makeDue(d2); // the test does not wait 24 h; the claim requires the attempt to be DUE
        const t0 = Date.now();
        last = await dispatch.attemptDelivery(d2);
        const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: d2 }, select: { nextAttemptAt: true } });
        if (row.nextAttemptAt) delays.push(Math.round((row.nextAttemptAt.getTime() - t0) / 1000) * 1000);
      }
    }
    const closeTo = delays.length === 7 && delays.every((d, i) => Math.abs(d - (CONTRACT_SCHEDULE[i] as number)) <= 2000);
    check(closeTo, "C1. after failures 1..7 the next attempt is 1m,5m,30m,2h,6h,12h,24h later", delays.map((d) => `${d / 1000}s`).join(","));
    const exRow = d2 ? await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: d2 }, select: { status: true, attempts: true, nextAttemptAt: true } }) : null;
    check(last.outcome === "exhausted" && exRow?.status === "exhausted" && exRow.attempts === 8 && exRow.nextAttemptAt === null, "C2. the 8th failure (after the 24h retry) is exhausted, with no next attempt", JSON.stringify(exRow));
    const posts = received.length;
    if (d2) { await makeDue(d2); await dispatch.attemptDelivery(d2); }
    check(posts === 8 && received.length === 8, "C3. an exhausted delivery is never POSTed again", `posts ${posts} → ${received.length}`);
    check(JSON.stringify(dispatch.RETRY_SCHEDULE_MS) === JSON.stringify(CONTRACT_SCHEDULE) && dispatch.MAX_ATTEMPTS === 8, "C4. the exported schedule IS the contract's (one source for C1)", JSON.stringify(dispatch.RETRY_SCHEDULE_MS));

    const notDue = await enqueueDeposit(await mkAddress(`samaprime:m1:user:notdue`), "samaprime:m1:user:notdue");
    if (notDue.deliveryId) await prisma.webhookDelivery.update({ where: { id: notDue.deliveryId }, data: { nextAttemptAt: new Date(Date.now() + 5 * MIN) } });
    received.length = 0; mode = "ok";
    const ndOut = notDue.deliveryId ? await dispatch.attemptDelivery(notDue.deliveryId) : { outcome: "none" };
    check(ndOut.outcome === "not_claimed" && received.length === 0, "C5. an attempt that is not DUE yet is not sent (a stale worker cannot jump the schedule)", `outcome=${ndOut.outcome} posts=${received.length}`);

    // ── D. the 10 s timeout ─────────────────────────────────────────────────
    const plain3 = await mkAddress(`samaprime:m1:user:u3`);
    const dep3 = await mkDeposit(plain3.id);
    const snap3 = depSnapshot(dep3.id, dep3.txHash, plain3.address, "samaprime:m1:user:u3");
    const enq3 = events ? await prisma.$transaction((tx) => events.enqueueEvent(tx, { type: "deposit.confirmed", objectKind: "deposit", objectId: snap3.id, snapshot: snap3 })) : null;
    const d3 = enq3 && enq3.status !== "suppressed" ? enq3.deliveryId : null;
    mode = "hang";
    const t0 = Date.now();
    const out3 = d3 ? await dispatch.attemptDelivery(d3) : { outcome: "none" };
    const took = Date.now() - t0;
    const r3 = d3 ? await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: d3 }, select: { status: true, lastError: true, attempts: true } }) : null;
    check(out3.outcome === "retry" && took >= 9_500 && took < 13_000 && r3?.status === "pending" && r3.attempts === 1, "D1. a receiver that never answers is abandoned at ~10 s and scheduled for retry", `took=${took}ms outcome=${out3.outcome} lastError=${r3?.lastError}`);
    for (const res of hanging.splice(0)) res.destroy();
    mode = "ok";

    // ── E. exactly-once enqueue under concurrency ───────────────────────────
    const plain4 = await mkAddress(`samaprime:m1:user:u4`);
    const dep4 = await mkDeposit(plain4.id);
    const snap4 = depSnapshot(dep4.id, dep4.txHash, plain4.address, "samaprime:m1:user:u4");
    const N = 8;
    const outs = events ? await Promise.allSettled(Array.from({ length: N }, () => prisma.$transaction((tx) => events.enqueueEvent(tx, { type: "deposit.confirmed", objectKind: "deposit", objectId: snap4.id, snapshot: snap4 })))) : [];
    const fulfilled = outs.filter((o) => o.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<EventsModule["enqueueEvent"]>>>[];
    const created = fulfilled.filter((o) => o.value.status === "created").length;
    const ids = new Set(fulfilled.map((o) => (o.value.status !== "suppressed" ? o.value.eventId : "")));
    const evCount = await eventsFor(snap4.id);
    const dvCount = events ? await prisma.webhookDelivery.count({ where: { eventId: [...ids][0] ?? "none" } }) : -1;
    check(fulfilled.length === N && created === 1 && ids.size === 1 && evCount === 1 && dvCount === 1, `E1. ${N} concurrent enqueues of one (object, type): all succeed, ONE created, one event row, one delivery`, `fulfilled=${fulfilled.length} created=${created} distinctIds=${ids.size} events=${evCount} deliveries=${dvCount}`);
    const again = events ? await prisma.$transaction((tx) => events.enqueueEvent(tx, { type: "deposit.confirmed", objectKind: "deposit", objectId: snap4.id, snapshot: snap4 })) : null;
    check(again?.status === "existing" && again.eventId === [...ids][0], "E2. a later enqueue returns the SAME event, status existing", JSON.stringify(again));
    const rolled = events ? await prisma.$transaction(async (tx) => { await events.enqueueEvent(tx, { type: "deposit.confirmed", objectKind: "deposit", objectId: `dep_${(await mkDeposit(plain4.id)).id}`, snapshot: snap4 }); return "no-throw"; }).catch((e: Error) => e.constructor.name) : "none";
    check(rolled !== "no-throw", "E3. CONTROL — a snapshot whose id is not the objectId is refused", rolled);

    // ── F. deposit.confirmed for every confirmed deposit (v1.1 A1) ─────────
    const intentAddr = await mkAddress(`pi-owner`);
    const piId = `pi_g3${RUN}${idx}`;
    await prisma.paymentIntent.create({ data: { id: piId, clientId: clientA.id, keyId: keyA.id, addressId: intentAddr.id, chain: "TRC20", amount: new Prisma.Decimal("5"), reference: "store:intent:1", expiresAt: new Date(Date.now() + H) } });
    const fi = await enqueueDeposit(intentAddr, "pi-owner", piId);
    const nI = await eventsFor(fi.snap.id);
    const dvI = fi.deliveryId ? await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: fi.deliveryId }, select: { payload: true } }) : null;
    const dvIObj = (dvI?.payload as { data?: { object?: { payment_intent_id?: unknown } } } | undefined)?.data?.object;
    check(fi.out?.status === "created" && nI === 1 && dvIObj?.payment_intent_id === piId, "F1. a deposit to an INTENT address DOES produce deposit.confirmed, with data.object.payment_intent_id set (A1)", `${JSON.stringify(fi.out)} events=${nI} pi=${String(dvIObj?.payment_intent_id)}`);
    const piEvt = events ? await prisma.$transaction((tx) => events.enqueueEvent(tx, { type: "payment_intent.succeeded", objectKind: "payment_intent", objectId: piId, snapshot: { id: piId, object: "payment_intent", status: "succeeded" } })) : null;
    check(piEvt?.status === "created", "F2. the same intent also gets its payment_intent.succeeded (status/UX event)", JSON.stringify(piEvt));
    const disabled = await mkAddress(`samaprime:m1:user:disabled`);
    await prisma.address.update({ where: { id: disabled.id }, data: { watchDisabledAt: new Date() } });
    const fd = await enqueueDeposit(disabled, "samaprime:m1:user:disabled");
    check(fd.out?.status === "suppressed" && fd.out.reason === "watch_disabled" && (await eventsFor(fd.snap.id)) === 0, "F3. a deposit to a watch-DISABLED address produces no deposit.confirmed", JSON.stringify(fd.out));
    const legacy = await mkAddress(`samaprime:m1:user:legacy`);
    await prisma.address.update({ where: { id: legacy.id }, data: { legacyImport: true } });
    await prisma.scanCursor.upsert({ where: { chain: "TRC20" }, create: { chain: "TRC20", lastScannedBlock: 1n, legacyWatchEnabledAt: null }, update: { legacyWatchEnabledAt: null } });
    const fl = await enqueueDeposit(legacy, "samaprime:m1:user:legacy");
    check(fl.out?.status === "suppressed" && fl.out.reason === "legacy_not_watched" && (await eventsFor(fl.snap.id)) === 0, "F4. a legacy_import address on a chain whose legacy watch is NOT enabled produces nothing (MNTAD's scanner still owns it)", JSON.stringify(fl.out));
    await prisma.scanCursor.update({ where: { chain: "TRC20" }, data: { legacyWatchEnabledAt: new Date() } });
    const fl2 = await enqueueDeposit(legacy, "samaprime:m1:user:legacy");
    check(fl2.out?.status === "created", "F5. CONTROL — the same legacy address after legacy_watch_enabled_at is set DOES produce one", JSON.stringify(fl2.out));
    // The OLD enqueue path (the observer's call on this base) holds the same rule at SEND time.
    mode = "ok"; received.length = 0;
    const legacyDep = await mkDeposit(disabled.id);
    const legacyId = await dispatch.enqueue(keyA.id, "deposit.confirmed", `dep_${legacyDep.id}`, { deposit_id: legacyDep.id });
    const legacyOut = await dispatch.attemptDelivery(legacyId);
    const legacyRow = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: legacyId }, select: { status: true, nextAttemptAt: true } });
    check(received.length === 0 && legacyOut.outcome === "suppressed" && legacyRow.status === "failed" && legacyRow.nextAttemptAt === null, "F6. via the OLD enqueue path a watch-disabled deposit.confirmed is never POSTed and never retried", `posts=${received.length} outcome=${legacyOut.outcome} status=${legacyRow.status}`);
    const mismatch = events ? await prisma.$transaction((tx) => events.enqueueEvent(tx, { type: "deposit.confirmed", objectKind: "payment_intent", objectId: piId, snapshot: { id: piId, object: "payment_intent" } })).then(() => "no-throw").catch((e: Error) => e.constructor.name) : "none";
    check(mismatch !== "no-throw", "F7. CONTROL — a type that does not belong to the object kind is refused", mismatch);

    // ── G. getEvent scoping ─────────────────────────────────────────────────
    const own = events && enq && enq.status !== "suppressed" ? await events.getEvent(clientA.id, enq.eventId) : null;
    const foreign = events && enq && enq.status !== "suppressed" ? await events.getEvent(clientB.id, enq.eventId) : "no-module";
    const unknown = events ? await events.getEvent(clientA.id, "evt_doesnotexist000000000000") : "no-module";
    check(!!own && own.id === enqEventId && own.object === "event" && canon(own) === (got?.body ? canon(JSON.parse(got.body)) : ""), "G1. the owner's getEvent returns the same envelope the webhook carried", JSON.stringify(own).slice(0, 80));
    check(foreign === null, "G2. another client's getEvent is null (the route answers 404 — no existence oracle)", String(foreign));
    check(unknown === null, "G3. an unknown id is null, the same answer as another client's", String(unknown));

    // ── H. dispatch to the client's CURRENT active key (A6) ─────────────────
    const keyA2 = await issueKey({ clientId: clientA.id, name: "a-rotated", scopes: ["deposits.read"], issuedBy: "verify", issuedVia: "cli", webhookUrl: `http://127.0.0.1:${port}/hook2` });
    await prisma.clientKey.update({ where: { id: keyA.id }, data: { active: false, revokedAt: new Date(), revokedReason: "rotated", successorKeyId: keyA2.id } });
    const hr = await enqueueDeposit(await mkAddress(`samaprime:m1:user:rot`), "samaprime:m1:user:rot"); // the address/deposit stay on the OLD key
    mode = "ok"; received.length = 0;
    const hOut = hr.deliveryId ? await dispatch.attemptDelivery(hr.deliveryId) : { outcome: "none" };
    const hGot = received[0];
    check(hOut.outcome === "delivered" && hGot?.url === "/hook2", "H1. a delivery enqueued under the revoked key goes to the client's CURRENT key URL", `outcome=${hOut.outcome} url=${hGot?.url}`);
    check(!!hGot && sign.verifySignature(keyA2.webhookSecret ?? "", hGot.body, String(hGot.headers["x-samapay-signature"])) && !sign.verifySignature(plainSecret, hGot.body, String(hGot.headers["x-samapay-signature"])), "H2. …signed with the CURRENT key's secret, not the revoked key's");
    await prisma.clientKey.update({ where: { id: keyA2.id }, data: { active: false } });
    const hn = await enqueueDeposit(await mkAddress(`samaprime:m1:user:nokey`), "samaprime:m1:user:nokey");
    received.length = 0;
    const hnOut = hn.deliveryId ? await dispatch.attemptDelivery(hn.deliveryId) : { outcome: "none" };
    const hnRow = hn.deliveryId ? await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: hn.deliveryId }, select: { status: true, lastError: true, nextAttemptAt: true } }) : null;
    check(received.length === 0 && hnOut.outcome === "retry" && hnRow?.status === "pending" && !!hnRow.nextAttemptAt && /no active key/.test(hnRow.lastError ?? ""), "H3. a client with NO active key: nothing sent, the delivery stays on the retry schedule (never lost)", `outcome=${hnOut.outcome} ${JSON.stringify(hnRow)}`);
    await prisma.clientKey.update({ where: { id: keyA2.id }, data: { active: true } });

    // ── I. the delivery claim (A7) ──────────────────────────────────────────
    const ic = await enqueueDeposit(await mkAddress(`samaprime:m1:user:claim`), "samaprime:m1:user:claim");
    mode = "slow"; received.length = 0;
    const racers = ic.deliveryId ? await Promise.all(Array.from({ length: 4 }, () => dispatch.attemptDelivery(ic.deliveryId as string))) : [];
    const won = racers.filter((r) => r.outcome === "delivered").length, lost = racers.filter((r) => r.outcome === "not_claimed").length;
    check(dispatch.CLAIM_LEASE_MS > dispatch.TIMEOUT_MS, "I0. the claim lease outlasts the 10 s timeout (a live attempt never loses its lease)", `${dispatch.CLAIM_LEASE_MS} > ${dispatch.TIMEOUT_MS}`);
    check(received.length === 1 && won === 1 && lost === 3, "I1. four workers attempt one due delivery at once: exactly ONE POST, one delivered, three not_claimed", `posts=${received.length} ${racers.map((r) => r.outcome).join(",")}`);
    mode = "ok";
    const held = await enqueueDeposit(await mkAddress(`samaprime:m1:user:held`), "samaprime:m1:user:held");
    if (held.deliveryId) await prisma.webhookDelivery.update({ where: { id: held.deliveryId }, data: { nextAttemptAt: new Date(Date.now() + dispatch.CLAIM_LEASE_MS - 5_000) } }); // a live lease another worker took moments ago
    received.length = 0;
    const heldOut = held.deliveryId ? await dispatch.attemptDelivery(held.deliveryId) : { outcome: "none" };
    check(heldOut.outcome === "not_claimed" && received.length === 0, "I2. a delivery another worker claimed moments ago is not sent again", `outcome=${heldOut.outcome} posts=${received.length}`);
    if (held.deliveryId) await prisma.webhookDelivery.update({ where: { id: held.deliveryId }, data: { nextAttemptAt: new Date(Date.now() - 1_000) } }); // that worker died: its lease ran out
    const staleOut = held.deliveryId ? await dispatch.attemptDelivery(held.deliveryId) : { outcome: "none" };
    check(staleOut.outcome === "delivered" && received.length === 1, "I3. a lease that ran out (a crashed worker) is taken over and delivered", `outcome=${staleOut.outcome} posts=${received.length}`);

    // ── J. redrive (A5/A9) ──────────────────────────────────────────────────
    const exBefore = d2 ? await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: d2 }, select: { status: true, attempts: true } }) : null;
    const cli = spawnSync("./node_modules/.bin/tsx", ["scripts/ops/redrive-deliveries.ts", `--since=${testStart.toISOString()}`], { encoding: "utf8", env: process.env });
    const exAfterCli = d2 ? await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: d2 }, select: { status: true, attempts: true } }) : null;
    check(cli.status === 0 && /DRY RUN/.test(cli.stdout) && !!d2 && cli.stdout.includes(d2) && exBefore?.status === "exhausted" && exAfterCli?.status === "exhausted" && exAfterCli.attempts === 8, "J1. the CLI without --apply is a DRY RUN: it lists the exhausted delivery and changes nothing", `exit=${cli.status} ${cli.stdout.split("\n").slice(0, 3).join(" | ")} ${cli.stderr.slice(0, 200)}`);
    const noSince = spawnSync("./node_modules/.bin/tsx", ["scripts/ops/redrive-deliveries.ts", "--apply"], { encoding: "utf8", env: process.env });
    check(noSince.status !== 0 && exAfterCli?.status === "exhausted", "J2. CONTROL — the CLI refuses without --since", `exit=${noSince.status}`);
    const future = redrive ? await redrive.redriveDeliveries({ since: new Date(Date.now() + H), apply: true, actor: "verify" }) : null;
    check(future?.candidates.length === 0 && future.requeued === 0, "J3. --since after the row's creation selects nothing", JSON.stringify(future));
    const applied = redrive ? await redrive.redriveDeliveries({ since: testStart, apply: true, actor: "verify" }) : null;
    const reRow = d2 ? await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: d2 }, select: { status: true, attempts: true, nextAttemptAt: true } }) : null;
    check(!!applied && !!d2 && applied.candidates.includes(d2) && applied.requeued === applied.candidates.length && reRow?.status === "pending" && reRow.attempts === 0 && !!reRow.nextAttemptAt && reRow.nextAttemptAt.getTime() <= Date.now(), "J4. --apply re-queues the exhausted delivery: pending, attempts 0, due now", `${JSON.stringify(applied)} ${JSON.stringify(reRow)}`);
    const again2 = redrive ? await redrive.redriveDeliveries({ since: testStart, apply: true, actor: "verify" }) : null;
    check(again2?.requeued === 0 && again2.candidates.length === 0, "J5. re-running --apply re-queues nothing (idempotent)", JSON.stringify(again2));
    const deliveredStill = deliveryId ? await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: deliveryId }, select: { status: true } }) : null;
    const failedStill = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: legacyId }, select: { status: true } });
    check(deliveredStill?.status === "delivered" && failedStill.status === "failed", "J6. delivered and suppressed (failed) deliveries are never redriven", `${deliveredStill?.status} ${failedStill.status}`);
    mode = "ok"; received.length = 0;
    const redelivered = d2 ? await dispatch.attemptDelivery(d2) : { outcome: "none" };
    check(redelivered.outcome === "delivered" && received.length === 1, "J7. the redriven delivery is then sent normally", `outcome=${redelivered.outcome}`);
  } catch (err) {
    check(false, "THE SUITE THREW — nothing below this point ran", String(err instanceof Error ? err.stack : err));
  } finally {
    for (const res of hanging.splice(0)) res.destroy();
    server.close();
    await prisma.$disconnect();
  }
  process.exit(summary());
}
main().catch((e) => { console.error("verify-webhook-contract crashed:", e); process.exit(1); });
