// COVERS: src/http/app.ts src/http/routes/payment-intents.ts src/http/routes/deposits.ts src/http/routes/events.ts src/http/routes/addresses.ts src/http/routes/balance.ts src/render/deposit.ts src/intents/create.ts src/intents/render.ts src/observer/index.ts src/events/index.ts
//
// THE WHOLE PHASE 0 RAIL THROUGH THE REAL APP AND THE REAL MODULES, in-process
// (no port, no chain): the ONLY double is the chain adapter (deterministic
// derivations above the floor, a transfer list and a confirmation count we
// control). createIntent (G2), the observer (G2), enqueueEvent/getEvent (G3),
// balance (G6) and every route (G1) are the production code, composed by the
// real entry point (src/server.ts bootApi). Balance checks carried over from
// G6's stop-gap version of this file: pending vs available, never clamped.
//
//   top-up address → intent (real createIntent) → transfer seen → processing →
//   confirmed → succeeded → deposit.confirmed + payment_intent.succeeded events
//   → GET /v1/events/:id data.object DEEP-EQUALS GET /v1/deposits/:id and
//   GET /v1/payment-intents/:id (the one-renderer gate) → balance → another
//   client sees none of it → withdrawals refuse in Phase 0.
//
// verify-api-contract.ts proves the error table and idempotency with fakes;
// this suite proves the pieces compose.
//
// Run on a disposable cluster only:
//   bash /www/wwwroot/samaprime.com/scripts/throwaway-pg.sh \
//     ./node_modules/.bin/tsx scripts/throwaway-sandbox.ts scripts/verify-routes-end-to-end.ts
import { isDeepStrictEqual } from "node:util";
import { Prisma } from "@prisma/client";
import { assertSandboxDatabase } from "@/db/guard.js";
import { prisma } from "@/db/client.js";
import { bootApi } from "@/server.js";
import { issueKey } from "@/keys/issue.js";
import { setChainAdapters } from "@/chain/registry.js";
import { observeChain } from "@/observer/index.js";
import { setEventSink } from "@/intents/index.js";
import { enqueueEvent } from "@/events/index.js";
import type { ObservedTransfer } from "@/chain/types.js";

// Configuration the API process has in production, set for THIS process only:
// the index floor (approved value) and mainnet chain config (built-in defaults;
// read for confirmations_required only — no RPC is ever contacted here).
process.env.SAMAPAY_DERIVATION_FLOOR_TRC20 = "1000";
process.env.SAMAPAY_DERIVATION_FLOOR_BEP20 = "1000";
process.env.CRYPTO_MODE = "mainnet";
const TRC20_DEPTH = 19; // getChainConfig("TRC20").confirmationsRequired on mainnet defaults

let pass = 0, fail = 0;
function check(ok: boolean, label: string, detail = "") { if (ok) pass++; else fail++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`); }
const RUN = Date.now();
const ALL = ["payment_intents.write", "payment_intents.read", "deposits.read", "addresses.write", "balance.read", "events.read"];
type Json = Record<string, unknown> & { error?: { code: string } };

async function main() {
  console.log(`database: ${await assertSandboxDatabase()}`);
  const app = bootApi();          // THE API composition root (ports wired, live deriver installed — replaced below)
  setEventSink(enqueueEvent);     // the composition the worker does
  const made = { clients: [] as string[], keys: [] as string[] };

  let nextIndex = 2_000_000 + (RUN % 100_000) * 10;
  const transfers: ObservedTransfer[] = []; let confirmations = 0;
  const fakeObserver = { async scan() { return transfers; }, async confirmationsFor() { return confirmations; } };
  setChainAdapters({ // after bootApi: the fake chain replaces the live deriver
    deriver: { async deriveNext(chain) { const i = nextIndex++; return { chain, address: `TE2E${RUN}${i}`, derivationIndex: i }; } },
    observer: fakeObserver,
  });
  const tick = () => observeChain("TRC20", fakeObserver, TRC20_DEPTH);

  try {
    const cA = await prisma.client.create({ data: { name: `verify-e2e-A-${RUN}`, kind: "merchant" } }); made.clients.push(cA.id);
    const cB = await prisma.client.create({ data: { name: `verify-e2e-B-${RUN}`, kind: "merchant" } }); made.clients.push(cB.id);
    const A = await issueKey({ clientId: cA.id, name: "A", scopes: ALL, issuedBy: "verify", issuedVia: "cli" }); made.keys.push(A.id);
    const B = await issueKey({ clientId: cB.id, name: "B", scopes: ALL, issuedBy: "verify", issuedVia: "cli" }); made.keys.push(B.id);
    await prisma.clientKey.updateMany({ where: { id: { in: made.keys } }, data: { rpsLimit: 100_000 } });
    let seq = 0;
    const req = async (method: string, path: string, key: string, body?: unknown, idem?: string) => {
      const headers: Record<string, string> = { authorization: `Bearer ${key}`, "content-type": "application/json" };
      if (method === "POST") headers["idempotency-key"] = idem ?? `e2e-${RUN}-${++seq}`;
      const res = await app.request(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      return { res, status: res.status, json: (await res.json().catch(() => ({}))) as Json };
    };

    // 1. a per-customer top-up address; the same (chain, reference) is the same address
    const ref = `samaprime:m${RUN}:user:u1`;
    const t1 = await req("POST", "/v1/addresses", A.plaintext, { chain: "TRC20", reference: ref });
    const t2 = await req("POST", "/v1/addresses", A.plaintext, { chain: "TRC20", reference: ref });
    check(t1.status === 201 && t2.status === 200 && t1.json.address === t2.json.address && t1.json.object === "address", "1. POST /v1/addresses issues once; the same (chain, reference) returns the same address", `${t1.status}/${t2.status}`);

    // 2. an intent through the REAL createIntent: fresh address above the floor
    const idem = `e2e-intent-${RUN}`;
    const p1 = await req("POST", "/v1/payment-intents", A.plaintext, { amount: "12.5", chain: "TRC20", reference: `order-${RUN}` }, idem);
    const pi = p1.json;
    const piAddr = await prisma.address.findFirst({ where: { address: String(pi.address) }, select: { derivationIndex: true, reference: true } });
    check(p1.status === 201 && String(pi.id).startsWith("pi_") && pi.status === "requires_payment" && pi.confirmations_required === TRC20_DEPTH && (piAddr?.derivationIndex ?? 0) > 1000 && piAddr?.reference === `payment_intent:${pi.id}` && pi.address !== t1.json.address,
      "2. POST /v1/payment-intents (real createIntent) → 201 requires_payment on a FRESH address above the floor", `${p1.status} ${JSON.stringify(pi).slice(0, 160)} index=${piAddr?.derivationIndex}`);
    const p1r = await req("POST", "/v1/payment-intents", A.plaintext, { amount: "12.5", chain: "TRC20", reference: `order-${RUN}` }, idem);
    check(p1r.status === 201 && p1r.res.headers.get("idempotent-replayed") === "true" && p1r.json.id === pi.id && (await prisma.paymentIntent.count({ where: { clientId: cA.id } })) === 1, "2b. replay → same intent, Idempotent-Replayed, ONE row", `${p1r.status}`);

    // 3. the transfer is seen, unconfirmed → processing
    transfers.push({ chain: "TRC20", txHash: `e2etx${RUN}a`, toAddress: String(pi.address), amount: "12.5", blockNumber: 10n, confirmations: 0 });
    transfers.push({ chain: "TRC20", txHash: `e2etx${RUN}b`, toAddress: String(t1.json.address), amount: "3.25", blockNumber: 10n, confirmations: 0 });
    await tick();
    const bal0 = await req("GET", "/v1/balance", A.plaintext);
    const trc0 = (bal0.json.chains as Record<string, { available: string; pending: string }> | undefined)?.TRC20;
    check(trc0?.available === "0" && trc0?.pending === "15.75", "3a. /v1/balance: DETECTED deposits count in pending (12.5 + 3.25), not in available", JSON.stringify(bal0.json.chains));
    const g3 = await req("GET", `/v1/payment-intents/${pi.id}`, A.plaintext);
    check(g3.json.status === "processing" && g3.json.amount_received === "0", "3. a detected, unconfirmed transfer → processing, amount_received still 0", `${g3.json.status} ${g3.json.amount_received}`);

    // 4. confirmed → succeeded, exactly once
    confirmations = TRC20_DEPTH;
    await tick(); await tick();
    const g4 = await req("GET", `/v1/payment-intents/${pi.id}`, A.plaintext);
    check(g4.json.status === "succeeded" && g4.json.amount_received === "12.5" && JSON.stringify(g4.json.tx_hashes) === JSON.stringify([`e2etx${RUN}a`]), "4. confirmed → succeeded; amount_received 12.5; tx_hashes", `${g4.json.status} ${g4.json.amount_received}`);

    // 5. deposits over REST
    const dl = await req("GET", `/v1/deposits?payment_intent_id=${pi.id}`, A.plaintext);
    const dep = ((dl.json.data ?? []) as Json[])[0] ?? {};
    const d1 = await req("GET", `/v1/deposits/${dep.id}`, A.plaintext);
    check(dl.status === 200 && String(dep.id).startsWith("dep_") && d1.status === 200 && d1.json.reference === `order-${RUN}` && d1.json.payment_intent_id === pi.id && d1.json.status === "confirmed",
      "5. GET /v1/deposits/:id — public id dep_…, reference = the intent's, confirmed", JSON.stringify(d1.json).slice(0, 200));
    const raw = String(dep.id).slice(4);
    const dRaw = await req("GET", `/v1/deposits/${raw}`, A.plaintext);
    check(dRaw.status === 404 && dRaw.json.error?.code === "not_found", "5b. the UNPREFIXED row id is not an id: 404 not_found", `${dRaw.status}`);

    // 6. THE ONE-RENDERER GATE: the event snapshot and the REST body are the same object
    const evDep = await prisma.event.findFirst({ where: { objectId: String(dep.id), type: "deposit.confirmed" }, select: { id: true } });
    const evPi = await prisma.event.findFirst({ where: { objectId: String(pi.id), type: "payment_intent.succeeded" }, select: { id: true } });
    const e1 = evDep ? await req("GET", `/v1/events/${evDep.id}`, A.plaintext) : null;
    const e2 = evPi ? await req("GET", `/v1/events/${evPi.id}`, A.plaintext) : null;
    const snapDep = (e1?.json.data as { object?: unknown } | undefined)?.object;
    const snapPi = (e2?.json.data as { object?: unknown } | undefined)?.object;
    check(e1?.status === 200 && isDeepStrictEqual(snapDep, d1.json), "6. GATE — deposit.confirmed data.object DEEP-EQUALS GET /v1/deposits/:id", `event=${JSON.stringify(snapDep)} rest=${JSON.stringify(d1.json)}`);
    check(e2?.status === 200 && isDeepStrictEqual(snapPi, g4.json), "6b. GATE — payment_intent.succeeded data.object DEEP-EQUALS GET /v1/payment-intents/:id", `event=${JSON.stringify(snapPi)} rest=${JSON.stringify(g4.json)}`);
    const events = await prisma.event.count({ where: { clientId: cA.id } });
    check(events === 3, "6c. exactly three events: deposit.confirmed ×2 (intent + top-up, A1) and payment_intent.succeeded ×1, after three ticks", `${events}`);
    const topDep = await prisma.deposit.findFirst({ where: { txHash: `e2etx${RUN}b` }, select: { id: true } });
    const td = await req("GET", `/v1/deposits/dep_${topDep?.id}`, A.plaintext);
    const evTop = await prisma.event.findFirst({ where: { objectId: `dep_${topDep?.id}`, type: "deposit.confirmed" }, select: { id: true } });
    const e3 = evTop ? await req("GET", `/v1/events/${evTop.id}`, A.plaintext) : null;
    check(td.json.reference === ref && td.json.payment_intent_id === null && isDeepStrictEqual((e3?.json.data as { object?: unknown } | undefined)?.object, td.json),
      "6d. GATE — a top-up deposit: REST body deep-equals its deposit.confirmed snapshot; reference = the address's", JSON.stringify(td.json).slice(0, 160));

    // 7. balance (G6) sees both confirmed deposits
    const bal = await req("GET", "/v1/balance", A.plaintext);
    const trc = (bal.json.chains as Record<string, { available: string }> | undefined)?.TRC20;
    check(bal.status === 200 && bal.json.object === "balance" && trc?.available === "15.75", "7. GET /v1/balance: TRC20 available = 12.5 + 3.25", JSON.stringify(bal.json));

    // 7b. CONTROL — available is never clamped: force a consuming withdrawal larger than received.
    await prisma.withdrawal.create({ data: { keyId: A.id, toAddress: "T" + "f".repeat(33), chain: "TRC20", amount: new Prisma.Decimal("20"), status: "sent", idempotencyKey: `forced-${RUN}` } });
    const bal2 = await req("GET", "/v1/balance", A.plaintext);
    const trc2 = (bal2.json.chains as Record<string, { available: string }> | undefined)?.TRC20;
    check(trc2?.available === "-4.25", "7b. CONTROL — /v1/balance never clamps: a forced 20 over-send reads -4.25", JSON.stringify(bal2.json.chains));

    // 8. ISOLATION — client B sees none of it
    const iB = await req("GET", `/v1/payment-intents/${pi.id}`, B.plaintext);
    const dB = await req("GET", `/v1/deposits/${dep.id}`, B.plaintext);
    const eB = evDep ? await req("GET", `/v1/events/${evDep.id}`, B.plaintext) : { status: 0 };
    const lB = await req("GET", "/v1/deposits", B.plaintext);
    const bB = await req("GET", "/v1/balance", B.plaintext);
    check(iB.status === 404 && dB.status === 404 && eB.status === 404 && (lB.json.data as unknown[]).length === 0 && (bB.json.chains as Record<string, { available: string }>)?.TRC20?.available === "0",
      "8. ISOLATION — client B: intent, deposit and event are 404; no deposits; balance 0", `${iB.status}/${dB.status}/${eB.status}`);

    // 9. Phase 0: no withdrawal route
    const w = await req("POST", "/v1/withdrawals", A.plaintext, { to: "T" + "x".repeat(33), amount: "1", chain: "TRC20" });
    check(w.status === 404 && (await prisma.withdrawal.count({ where: { keyId: A.id, idempotencyKey: { not: `forced-${RUN}` } } })) === 0, "9. Phase 0 refuses withdrawals: POST /v1/withdrawals is 404, no row written by the API", `${w.status}`);
  } catch (err) {
    // ⚠️ WITHOUT THIS, A CRASH REPORTS AS A CLEAN ZERO (the finally's exit discards it).
    fail++;
    console.error(`\n*** THE SUITE THREW — nothing below this point ran ***\n`, err);
  } finally {
    const keys = { in: made.keys };
    const eventIds = (await prisma.event.findMany({ where: { clientId: { in: made.clients } }, select: { id: true } })).map((e) => e.id);
    await prisma.webhookDelivery.deleteMany({ where: { keyId: keys } }).catch(() => undefined);
    await prisma.event.deleteMany({ where: { id: { in: eventIds } } }).catch(() => undefined);
    await prisma.withdrawal.deleteMany({ where: { keyId: keys } }).catch(() => undefined);
    await prisma.deposit.deleteMany({ where: { keyId: keys } }).catch(() => undefined);
    await prisma.paymentIntent.deleteMany({ where: { clientId: { in: made.clients } } }).catch(() => undefined);
    await prisma.idempotencyKey.deleteMany({ where: { keyId: keys } }).catch(() => undefined);
    await prisma.address.deleteMany({ where: { keyId: keys } }).catch(() => undefined);
    await prisma.clientKey.deleteMany({ where: { id: keys } }).catch(() => undefined);
    await prisma.client.deleteMany({ where: { id: { in: made.clients } } }).catch(() => undefined);
    // Keys/clients are pinned by their append-only audit rows (FK Restrict) — counted apart, by design.
    const left = (await prisma.deposit.count({ where: { keyId: keys } })) + (await prisma.paymentIntent.count({ where: { clientId: { in: made.clients } } })) + (await prisma.address.count({ where: { keyId: keys } })) + (await prisma.event.count({ where: { clientId: { in: made.clients } } })) + (await prisma.webhookDelivery.count({ where: { keyId: keys } }));
    const pinned = (await prisma.clientKey.count({ where: { id: keys } })) + (await prisma.client.count({ where: { id: { in: made.clients } } }));
    console.log(`\n${pass} passed, ${fail} failed · ${left} left behind (counted) · ${pinned} key/client rows pinned by audit rows (permanent by design)`);
    if (left !== 0) fail++;
    await prisma.$disconnect();
    // ⚠️ ZERO CHECKS IS **VOID**, NEVER A PASS.
    if (pass + fail === 0) { console.log("*** VOID — no check executed. This is NOT a pass. ***"); process.exit(1); }
    process.exit(fail === 0 ? 0 : 1);
  }
}
main().catch((e) => { console.error("verify-routes-end-to-end crashed:", e); process.exit(1); });
