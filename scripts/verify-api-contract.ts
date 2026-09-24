// COVERS: src/http/app.ts src/http/auth.ts src/http/scopes.ts src/http/errors.ts src/http/idempotency.ts src/http/routes/payment-intents.ts src/http/routes/deposits.ts src/http/routes/events.ts
//
// CONTRACT §2–§6 THROUGH THE REAL APP, in-process (no port, no chain).
// /root/pay-mntad-api-contract.md is the spec; every row of the §6 error
// table that G1 owns is reached here by a real request, not asserted from a
// constant. G2's createIntent and G3's getEvent are FAKES injected through
// the routes' wiring points — this suite proves the HTTP layer, not them.
//
// Run on a disposable cluster only:
//   bash /www/wwwroot/samaprime.com/scripts/throwaway-pg.sh \
//     ./node_modules/.bin/tsx scripts/throwaway-sandbox.ts scripts/verify-api-contract.ts
import { isDeepStrictEqual } from "node:util";
import { Prisma } from "@prisma/client";
import type { ObservedTransfer } from "@/chain/types.js";
import { assertSandboxDatabase } from "@/db/guard.js";
import { prisma } from "@/db/client.js";
import { buildApp } from "@/http/app.js";
import { issueKey } from "@/keys/issue.js";
import { setChainAdapters, ChainUnavailable } from "@/chain/registry.js";
import { isScope } from "@/http/scopes.js";

// Chain CONFIG only (confirmation depth for confirmations_required): mainnet
// resolves from built-in defaults with no env and no network call. No RPC is
// ever contacted by this suite.
process.env.CRYPTO_MODE = "mainnet";
// Loaded DYNAMICALLY so the suite still RUNS (and fails check by check) on
// code where these wiring points do not exist yet — the red-first run.
type CreateIntentInput = { amount: string; chain: "TRC20" | "BEP20"; reference: string; expiresInSec: number };
type Wiring = { setHealthReaders?: unknown; setCreateIntent?: (fn: (c: string, k: string, i: CreateIntentInput) => Promise<{ id: string }>) => void; setGetEvent?: (fn: (c: string, id: string) => Promise<Record<string, unknown> | null>) => void };
const loadWiring = async (spec: string): Promise<Wiring> => { try { return (await import(spec)) as Wiring; } catch { console.log(`  (wiring point ${spec} absent)`); return {}; } };

let pass = 0, fail = 0;
function check(ok: boolean, label: string, detail = "") { if (ok) pass++; else fail++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`); }
const RUN = Date.now();
const ALL = ["payment_intents.write", "payment_intents.read", "deposits.read", "addresses.write", "balance.read", "events.read"];
type Json = { error?: { code: string; message: string; request_id?: string; details?: Record<string, unknown> } } & Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`database: ${await assertSandboxDatabase()}`);
  // ── the composition root, BEFORE anything is wired (Q G2-review H2) ──
  const srv = (await loadWiring("@/server.js")) as { assertApiPortsWired?: () => void; bootApi?: () => { request: (p: string, i?: RequestInit) => Response | Promise<Response> } };
  let unwired = "";
  try { if (!srv.assertApiPortsWired) throw new Error("absent"); srv.assertApiPortsWired(); } catch (e) { unwired = e instanceof Error ? e.message : String(e); }
  check(/createIntent/.test(unwired) && /getEvent/.test(unwired), "BOOT — assertApiPortsWired refuses while createIntent and getEvent are unwired, naming both", unwired);
  const app = buildApp();
  const made = { clients: [] as string[], keys: [] as string[] };

  // ── fakes for G2 / G3 ──
  let nextIndex = 5_000_000 + (RUN % 100_000) * 10;
  let createCalls = 0; let createDelayMs = 0; let createThrows: Error | null = null;
  // Simulates losing G2's UNIQUE(client_id, reference) race: a concurrent winner's row is
  // written (with `raceWinnerAmount`), then createIntent answers ReferenceConflict.
  let raceWinnerAmount: string | null = null;
  const { setCreateIntent = () => undefined } = await loadWiring("@/http/routes/payment-intents.js");
  const { setGetEvent = () => undefined } = await loadWiring("@/http/routes/events.js");
  const { setHealthReaders = () => undefined } = (await loadWiring("@/http/routes/health.js")) as { setHealthReaders?: (r: Record<string, () => Promise<unknown>>) => void };
  // /health's observer-lag reader reads a live chain head: replaced BEFORE any
  // request, so this suite never reaches an RPC endpoint.
  setHealthReaders({ observerLagBlocks: async () => ({ TRC20: null, BEP20: null }) });
  // chain double for POST /addresses: deterministic, never a real derivation
  let deriverDown = false; let deriveDelayMs = 0; const gateTransfers: ObservedTransfer[] = [];
  const fakeDeriver = { async deriveNext(chain: "TRC20" | "BEP20") { if (deriverDown) throw new ChainUnavailable("verify"); if (deriveDelayMs) await sleep(deriveDelayMs); const i = nextIndex++; return { chain, address: `AVERIFY${RUN}${i}`, derivationIndex: i }; } };
  const fakeCreateIntent = async (clientId: string, keyId: string, input: CreateIntentInput) => {
    createCalls++;
    if (createDelayMs) await sleep(createDelayMs);
    if (createThrows) throw createThrows;
    const i = nextIndex++;
    // Mirrors G2: an intent's address carries reference "payment_intent:<pi>", not the store's.
    const address = await prisma.address.create({ data: { keyId, chain: input.chain, reference: `payment_intent:pi_verify${RUN}${i}`, address: `TVERIFY${RUN}${i}`, derivationIndex: i } });
    const row = await prisma.paymentIntent.create({ data: { id: `pi_verify${RUN}${i}`, clientId, keyId, addressId: address.id, chain: input.chain, amount: new Prisma.Decimal(raceWinnerAmount ?? input.amount), reference: input.reference, expiresAt: new Date(Date.now() + input.expiresInSec * 1000) } });
    if (raceWinnerAmount !== null) throw named("ReferenceConflict");
    return { id: row.id };
  };
  const installFakes = () => { setChainAdapters({ deriver: fakeDeriver }); setCreateIntent(fakeCreateIntent); };
  const named = (name: string, msg = name) => Object.assign(new Error(msg), { name });

  try {
    const cA = await prisma.client.create({ data: { name: `verify-api-A-${RUN}`, kind: "merchant", minIntent: new Prisma.Decimal(1), maxIntent: new Prisma.Decimal(10000), enabledChains: ["TRC20", "BEP20"] } }); made.clients.push(cA.id);
    const cB = await prisma.client.create({ data: { name: `verify-api-B-${RUN}`, kind: "merchant" } }); made.clients.push(cB.id);
    const cT = await prisma.client.create({ data: { name: `verify-api-TRC-${RUN}`, kind: "merchant", enabledChains: ["TRC20"] } }); made.clients.push(cT.id);
    const iss = async (clientId: string, name: string, scopes: string[]) => { const k = await issueKey({ clientId, name, scopes: scopes.filter(isScope), issuedBy: "verify", issuedVia: "cli" }); made.keys.push(k.id); return k; };
    const A = await iss(cA.id, "A", ALL);
    const A2 = await iss(cA.id, "A2", ALL); // a second key of the SAME client
    const B = await iss(cB.id, "B", ALL);
    const T = await iss(cT.id, "T", ALL);
    const RO = await iss(cA.id, "read-only", ["deposits.read"]);
    const SUCC = await iss(cA.id, "successor", ALL);
    const REV = await iss(cA.id, "revoked", ALL);
    await prisma.clientKey.update({ where: { id: REV.id }, data: { active: false, revokedAt: new Date(), revokedReason: "verify", successorKeyId: SUCC.id } });
    // Every other key gets a limit this suite cannot reach, so only SLOW ever sees a 429.
    await prisma.clientKey.updateMany({ where: { id: { in: made.keys } }, data: { rpsLimit: 100_000 } });
    const SLOW = await iss(cA.id, "rate", ALL);
    await prisma.clientKey.update({ where: { id: SLOW.id }, data: { rpsLimit: 2 } });

    const hdr = (k: string | null, idem?: string) => ({ ...(k ? { authorization: `Bearer ${k}` } : {}), "content-type": "application/json", ...(idem !== undefined ? { "idempotency-key": idem } : {}) });
    const call = async (method: string, path: string, key: string | null, body?: unknown, idem?: string) => {
      const res = await app.request(path, { method, headers: hdr(key, idem), ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
      const text = await res.text();
      let json: Json = {}; try { json = JSON.parse(text) as Json; } catch { /* not JSON */ }
      return { res, status: res.status, json, text, code: json.error?.code };
    };
    const good = { amount: "12.5", chain: "TRC20", reference: `store-${RUN}-1` };
    let seq = 0; const idem = () => `verify-${RUN}-${++seq}`;

    // ── BOOT: the REAL entry point wires the ports (src/server.ts bootApi) ──
    process.env.SAMAPAY_DERIVATION_FLOOR_TRC20 = "1000";
    process.env.SAMAPAY_DERIVATION_FLOOR_BEP20 = "1000";
    let booted: ReturnType<NonNullable<typeof srv.bootApi>> | null = null; let bootErr = "";
    try { booted = srv.bootApi ? srv.bootApi() : null; } catch (e) { bootErr = e instanceof Error ? e.message : String(e); }
    let wiredAfterBoot = true; try { srv.assertApiPortsWired?.(); } catch { wiredAfterBoot = false; }
    check(!!booted && wiredAfterBoot, "BOOT — bootApi() (the server entry point) boots and leaves every port wired", bootErr);
    if (booted) {
      const bp = await booted.request("/v1/payment-intents", { method: "POST", headers: hdr(A.plaintext, `boot-${RUN}`), body: JSON.stringify(good) });
      const bpj = (await bp.json().catch(() => ({}))) as Json;
      // Real createIntent + the live deriver on a cluster with NO seed: a clean 503. Unwired would be 500 internal.
      check(bp.status === 503 && bpj.error?.code === "derivation_unavailable", "BOOT — POST /v1/payment-intents reaches G2's createIntent (no seed here → 503 derivation_unavailable, not the unwired 500)", `${bp.status} ${bpj.error?.code}`);
      const be = await booted.request(`/v1/events/evt_${RUN}none`, { headers: hdr(A.plaintext) });
      const bej = (await be.json().catch(() => ({}))) as Json;
      check(be.status === 404 && bej.error?.code === "not_found", "BOOT — GET /v1/events/:id reaches G3's getEvent (unknown id → 404, not the unwired 500)", `${be.status} ${bej.error?.code}`);
    }
    installFakes(); // everything below proves the HTTP layer against fakes

    // ── §1 request id ──
    const r0 = await call("GET", "/v1/payment-intents", null);
    const rid = r0.res.headers.get("x-request-id");
    check(!!rid && r0.json.error?.request_id === rid, "§1 every response carries X-Request-Id and the error body echoes it", `header=${rid} body=${r0.json.error?.request_id}`);

    // ── §6 401 rows ──
    check(r0.status === 401 && r0.code === "unauthenticated", "§6 401 unauthenticated — no Authorization header", `${r0.status} ${r0.code}`);
    const r1 = await call("GET", "/v1/payment-intents", "garbage");
    check(r1.status === 401 && r1.code === "unauthenticated", "§6 401 unauthenticated — malformed Authorization", `${r1.status} ${r1.code}`);
    const unknownKey = `sk_live_${"a".repeat(40)}`;
    const r2 = await call("GET", "/v1/payment-intents", unknownKey);
    check(r2.status === 401 && r2.code === "invalid_key", "§6 401 invalid_key — well-formed, unknown key", `${r2.status} ${r2.code}`);
    const wrongSecret = A.plaintext.slice(0, -1) + (A.plaintext.endsWith("a") ? "b" : "a");
    const r3 = await call("GET", "/v1/payment-intents", wrongSecret);
    check(r3.status === 401 && r3.code === "invalid_key", "§6 401 invalid_key — known prefix, wrong secret", `${r3.status} ${r3.code}`);
    const r4 = await call("GET", "/v1/payment-intents", REV.plaintext);
    check(r4.status === 401 && r4.code === "key_revoked" && r4.json.error?.details?.successor === SUCC.plaintext.slice(-4), "§6 401 key_revoked — with details.successor = successor's last 4", `${r4.status} ${r4.code} ${JSON.stringify(r4.json.error?.details)}`);
    const revWrong = REV.plaintext.slice(0, -1) + (REV.plaintext.endsWith("a") ? "b" : "a");
    const r5 = await call("GET", "/v1/payment-intents", revWrong);
    check(r5.status === 401 && r5.code === "invalid_key", "§6 a WRONG secret on a revoked key is invalid_key, not key_revoked (no oracle)", `${r5.status} ${r5.code}`);

    // ── §6 403 ──
    const r6 = await call("POST", "/v1/payment-intents", RO.plaintext, good, idem());
    check(r6.status === 403 && r6.code === "insufficient_scope" && r6.json.error?.details?.required === "payment_intents.write", "§6 403 insufficient_scope — details.required names the scope (POST intent)", `${r6.status} ${r6.code} ${JSON.stringify(r6.json.error?.details)}`);
    const r6b = await call("GET", "/v1/events/evt_x", RO.plaintext);
    check(r6b.status === 403 && r6b.json.error?.details?.required === "events.read", "§6 403 insufficient_scope — GET events without events.read", `${r6b.status} ${r6b.code}`);
    const r6c = await call("GET", "/v1/payment-intents", RO.plaintext);
    check(r6c.status === 403 && r6c.json.error?.details?.required === "payment_intents.read", "§6 403 insufficient_scope — list intents without payment_intents.read", `${r6c.status}`);

    // ── §6 400 rows ──
    const r7 = await call("POST", "/v1/payment-intents", A.plaintext, good);
    check(r7.status === 400 && r7.code === "idempotency_key_required", "§6 400 idempotency_key_required — POST without Idempotency-Key", `${r7.status} ${r7.code}`);
    const r7b = await call("POST", "/v1/payment-intents", A.plaintext, good, "x".repeat(256));
    check(r7b.status === 400 && r7b.code === "idempotency_key_required", "§3 an Idempotency-Key of 256 chars is refused (1–255)", `${r7b.status} ${r7b.code}`);
    const r8 = await call("POST", "/v1/payment-intents", A.plaintext, "{not json", idem());
    check(r8.status === 400 && r8.code === "invalid_json", "§6 400 invalid_json — body is not JSON", `${r8.status} ${r8.code}`);
    const r9 = await call("POST", "/v1/payment-intents", A.plaintext, { chain: "TRC20", reference: "x" }, idem());
    check(r9.status === 400 && r9.code === "validation_failed" && Array.isArray(r9.json.error?.details?.fields) && (r9.json.error?.details?.fields as string[]).includes("amount"), "§6 400 validation_failed — details.fields lists `amount`", `${r9.status} ${r9.code} ${JSON.stringify(r9.json.error?.details)}`);
    const r9b = await call("POST", "/v1/payment-intents", A.plaintext, { ...good, amount: 12.5 }, idem());
    check(r9b.status === 400 && r9b.code === "validation_failed", "§1 money as a NUMBER is refused (strings only)", `${r9b.status} ${r9b.code}`);
    const r9c = await call("POST", "/v1/payment-intents", A.plaintext, { ...good, expires_in_sec: 299 }, idem());
    check(r9c.status === 400 && r9c.code === "validation_failed", "§5 expires_in_sec below 300 is validation_failed", `${r9c.status} ${r9c.code}`);

    // ── §6 422 rows ──
    for (const amount of ["0", "0.000000", "-1", "1.1234567"]) {
      const r = await call("POST", "/v1/payment-intents", A.plaintext, { ...good, amount }, idem());
      check(r.status === 422 && r.code === "amount_out_of_range", `§6 422 amount_out_of_range — amount "${amount}"`, `${r.status} ${r.code}`);
    }
    for (const amount of ["0.5", "10000.000001"]) {
      const r = await call("POST", "/v1/payment-intents", A.plaintext, { ...good, amount }, idem());
      check(r.status === 422 && r.code === "amount_out_of_range", `§5 min_intent/max_intent (1/10000) — amount "${amount}" is 422`, `${r.status} ${r.code}`);
    }
    createThrows = named("AmountOutOfRange");
    const r10 = await call("POST", "/v1/payment-intents", A.plaintext, good, idem());
    createThrows = null;
    check(r10.status === 422 && r10.code === "amount_out_of_range", "§6 422 amount_out_of_range — createIntent's AmountOutOfRange is mapped", `${r10.status} ${r10.code}`);
    const r11 = await call("POST", "/v1/payment-intents", A.plaintext, { ...good, chain: "ETH" }, idem());
    check(r11.status === 422 && r11.code === "unsupported_chain", "§6 422 unsupported_chain — unknown chain", `${r11.status} ${r11.code}`);
    const r11b = await call("POST", "/v1/payment-intents", T.plaintext, { ...good, chain: "BEP20" }, idem());
    check(r11b.status === 422 && r11b.code === "unsupported_chain", "§6 422 unsupported_chain — chain not enabled for THIS client", `${r11b.status} ${r11b.code}`);
    for (const reference of ["bad ref", "a/b", "x".repeat(201), ""]) {
      const r = await call("POST", "/v1/payment-intents", A.plaintext, { ...good, reference }, idem());
      check(r.status === 422 && r.code === "reference_invalid", `§6 422 reference_invalid — ${JSON.stringify(reference.length > 20 ? `${reference.length} chars` : reference)}`, `${r.status} ${r.code}`);
    }

    // ── §6 503 / 500 rows ──
    createThrows = named("DerivationUnavailable");
    const r12k = idem();
    const r12 = await call("POST", "/v1/payment-intents", A.plaintext, good, r12k);
    createThrows = named("ChainUnavailable");
    const r13 = await call("POST", "/v1/payment-intents", A.plaintext, good, idem());
    createThrows = new Error("db password=hunter2 leaked?");
    const r14 = await call("POST", "/v1/payment-intents", A.plaintext, good, idem());
    createThrows = null;
    check(r12.status === 503 && r12.code === "derivation_unavailable", "§6 503 derivation_unavailable", `${r12.status} ${r12.code}`);
    check(r13.status === 503 && r13.code === "chain_unavailable", "§6 503 chain_unavailable", `${r13.status} ${r13.code}`);
    check(r14.status === 500 && r14.code === "internal" && !JSON.stringify(r14.json).includes("hunter2") && !!r14.json.error?.request_id, "§6 500 internal — no internals leak, request_id present", `${r14.status} ${JSON.stringify(r14.json)}`);
    const r12retry = await call("POST", "/v1/payment-intents", A.plaintext, good, r12k);
    check(r12retry.status === 201 && r12retry.res.headers.get("idempotent-replayed") === null, "§3 after a 503 nothing was created: the SAME Idempotency-Key retries and creates (not a replay of the 503)", `${r12retry.status}`);

    // ── §4 object + §3 idempotency ──
    const k1 = idem();
    const callsBefore = createCalls;
    const p1 = await call("POST", "/v1/payment-intents", A.plaintext, { ...good, reference: `store-${RUN}-2` }, k1);
    const pi = p1.json as Record<string, unknown>;
    const shapeOk = p1.status === 201 && typeof pi.id === "string" && pi.object === "payment_intent" && pi.status === "requires_payment"
      && pi.amount === "12.5" && pi.amount_received === "0" && pi.fee_amount === "0" && pi.currency === "USDT" && pi.chain === "TRC20"
      && typeof pi.address === "string" && Array.isArray(pi.tx_hashes) && pi.confirmations_required === 19
      && typeof pi.expires_at === "string" && typeof pi.created_at === "string" && pi.succeeded_at === null && pi.expired_at === null;
    check(shapeOk, "§4 201 PaymentIntent — every field, snake_case, money as strings", JSON.stringify(pi));
    const exp = Date.parse(String(pi.expires_at)) - Date.parse(String(pi.created_at));
    check(Math.abs(exp - 3600_000) < 5000, "§5 expires_in_sec defaults to 3600", `${exp} ms`);
    // canonical body: same fields, different key order and whitespace
    const reordered = `{ "reference": "store-${RUN}-2",  "chain":"TRC20", "amount": "12.5" }`;
    const p1r = await call("POST", "/v1/payment-intents", A.plaintext, reordered, k1);
    check(p1r.status === 201 && p1r.res.headers.get("idempotent-replayed") === "true" && p1r.text === p1.text && createCalls === callsBefore + 1,
      "§3 replay (same key, same CANONICAL body, reordered) → original status+body, Idempotent-Replayed: true, createIntent ran once", `status=${p1r.status} replayed=${p1r.res.headers.get("idempotent-replayed")} calls=${createCalls - callsBefore}`);
    const p1m = await call("POST", "/v1/payment-intents", A.plaintext, { ...good, reference: `store-${RUN}-2`, amount: "13" }, k1);
    check(p1m.status === 409 && p1m.code === "idempotency_payload_mismatch" && createCalls === callsBefore + 1, "§6 409 idempotency_payload_mismatch — same key, different body; nothing created", `${p1m.status} ${p1m.code}`);
    const p1other = await call("POST", "/v1/payment-intents", B.plaintext, { ...good, reference: `store-${RUN}-2` }, k1);
    check(p1other.status === 201 && p1other.res.headers.get("idempotent-replayed") === null && p1other.json.id !== pi.id, "§3 scope is (key, Idempotency-Key): another key's same Idempotency-Key is its own request", `${p1other.status}`);
    // concurrency
    createDelayMs = 400;
    const kc = idem();
    const [c1, c2] = await Promise.all([
      call("POST", "/v1/payment-intents", A.plaintext, { ...good, reference: `store-${RUN}-3` }, kc),
      (async () => { await sleep(100); return call("POST", "/v1/payment-intents", A.plaintext, { ...good, reference: `store-${RUN}-3` }, kc); })(),
    ]);
    createDelayMs = 0;
    const createdForKc = await prisma.paymentIntent.count({ where: { clientId: cA.id, reference: `store-${RUN}-3` } });
    check(c1.status === 201 && c2.status === 409 && c2.code === "idempotency_in_progress" && createdForKc === 1, "§6 409 idempotency_in_progress — 2 concurrent same-key POSTs: one 201, one 409, ONE intent", `${c1.status}/${c2.status} ${c2.code} rows=${createdForKc}`);
    const c3 = await call("POST", "/v1/payment-intents", A.plaintext, { ...good, reference: `store-${RUN}-3` }, kc);
    check(c3.status === 201 && c3.res.headers.get("idempotent-replayed") === "true" && c3.json.id === c1.json.id, "§3 after the first finishes, the same key replays it", `${c3.status}`);

    // ── GET / 404 cross-client ──
    const g1 = await call("GET", `/v1/payment-intents/${pi.id}`, A.plaintext);
    check(g1.status === 200 && g1.json.id === pi.id && JSON.stringify({ ...g1.json }) === JSON.stringify({ ...pi }), "§5 GET /payment-intents/:id renders exactly what POST returned", `${g1.status}`);
    const g1b = await call("GET", `/v1/payment-intents/${pi.id}`, A2.plaintext);
    check(g1b.status === 200, "§2 another key of the SAME client reads it (the owner is the client)", `${g1b.status}`);
    const g2 = await call("GET", `/v1/payment-intents/${pi.id}`, B.plaintext);
    const g3 = await call("GET", `/v1/payment-intents/pi_does_not_exist_${RUN}`, B.plaintext);
    check(g2.status === 404 && g2.code === "not_found" && g3.status === 404 && g2.json.error?.message === g3.json.error?.message, "§2 another client's intent is 404 not_found, identical to an unknown id", `${g2.status}/${g3.status}`);

    // ── v1.1 A7: one intent per (client, reference) ──
    const callsA7 = createCalls;
    const same = await call("POST", "/v1/payment-intents", A.plaintext, { ...good, reference: `store-${RUN}-2` }, idem());
    check(same.status === 200 && same.json.id === pi.id && createCalls === callsA7, "A7 same reference + same amount/chain under a NEW Idempotency-Key → 200, the existing intent, nothing created", `${same.status} ${same.json.id === pi.id ? "same id" : "DIFFERENT id"}`);
    const conflict = await call("POST", "/v1/payment-intents", A.plaintext, { ...good, reference: `store-${RUN}-2`, amount: "13" }, idem());
    const conflictChain = await call("POST", "/v1/payment-intents", A.plaintext, { ...good, reference: `store-${RUN}-2`, chain: "BEP20" }, idem());
    check(conflict.status === 409 && conflict.code === "reference_conflict" && conflictChain.status === 409 && conflictChain.code === "reference_conflict" && createCalls === callsA7,
      "A7 same reference, different amount / chain → 409 reference_conflict, nothing created", `${conflict.status} ${conflict.code} / ${conflictChain.status} ${conflictChain.code}`);
    // B created its own store-2 above (p1other) while A held store-2: the uniqueness is per client.
    const otherClientSameRef = await call("POST", "/v1/payment-intents", B.plaintext, { ...good, reference: `store-${RUN}-2` }, idem());
    check(otherClientSameRef.status === 200 && otherClientSameRef.json.id === p1other.json.id && p1other.json.id !== pi.id, "A7 the uniqueness is per CLIENT: B's store-2 is B's own intent, not A's", `${otherClientSameRef.status}`);

    // A7 under a race: createIntent answers ReferenceConflict after another request won.
    raceWinnerAmount = "12.5";
    const race1 = await call("POST", "/v1/payment-intents", A.plaintext, { ...good, reference: `store-${RUN}-race1` }, idem());
    raceWinnerAmount = "99";
    const race2 = await call("POST", "/v1/payment-intents", A.plaintext, { ...good, reference: `store-${RUN}-race2` }, idem());
    raceWinnerAmount = null;
    const winner1 = await prisma.paymentIntent.findFirst({ where: { clientId: cA.id, reference: `store-${RUN}-race1` }, select: { id: true } });
    check(race1.status === 200 && race1.json.id === winner1?.id && race2.status === 409 && race2.code === "reference_conflict",
      "A7 race: createIntent's ReferenceConflict is re-read — the winner with the same amount → 200 it; a different amount → 409 reference_conflict", `${race1.status}/${race2.status} ${race2.code}`);

    // ── list (a dedicated client, so the count is exact) ──
    const cL = await prisma.client.create({ data: { name: `verify-api-L-${RUN}`, kind: "merchant" } }); made.clients.push(cL.id);
    const L = await iss(cL.id, "L", ALL);
    await prisma.clientKey.update({ where: { id: L.id }, data: { rpsLimit: 100_000 } });
    for (let i = 0; i < 3; i++) await call("POST", "/v1/payment-intents", L.plaintext, { ...good, reference: `store-${RUN}-list-${i}` }, idem());
    const l1 = await call("GET", `/v1/payment-intents?limit=2`, L.plaintext);
    const l1d = (l1.json.data ?? []) as Array<{ id: string; reference: string }>;
    const l2 = await call("GET", `/v1/payment-intents?limit=2&starting_after=${l1d[1]?.id}`, L.plaintext);
    const l2d = (l2.json.data ?? []) as Array<{ id: string }>;
    check(l1.status === 200 && l1.json.object === "list" && l1d.length === 2 && l1.json.has_more === true && l2d.length === 1 && l2.json.has_more === false && !l1d.some((x) => x.id === l2d[0]?.id),
      "§5 list: limit, has_more, starting_after pages without overlap", `${l1d.length}+${l2d.length} more=${l1.json.has_more}/${l2.json.has_more}`);
    const lr = await call("GET", `/v1/payment-intents?reference=store-${RUN}-list-1`, L.plaintext);
    check(lr.status === 200 && (lr.json.data as Array<{ reference: string }>).length === 1 && (lr.json.data as Array<{ reference: string }>)[0]?.reference === `store-${RUN}-list-1`, "§5 list: reference filter", `${(lr.json.data as unknown[]).length}`);
    const lB = await call("GET", `/v1/payment-intents?reference=store-${RUN}-list-1`, B.plaintext);
    check(lB.status === 200 && (lB.json.data as unknown[]).length === 0, "§2 list: another client sees none of them", `${(lB.json.data as unknown[]).length}`);
    const lBc = await call("GET", `/v1/payment-intents?starting_after=${l1d[0]?.id}`, B.plaintext);
    check(lBc.status === 404, "§2 list: another client's id as starting_after is 404", `${lBc.status}`);
    const lbad = await call("GET", `/v1/payment-intents?limit=101`, A.plaintext);
    check(lbad.status === 400 && lbad.code === "validation_failed", "§5 list: limit > 100 is validation_failed", `${lbad.status} ${lbad.code}`);
    const lst = await call("GET", `/v1/payment-intents?status=requires_payment`, L.plaintext);
    check(lst.status === 200 && (lst.json.data as unknown[]).length === 3, "§5 list: status filter", `${(lst.json.data as unknown[]).length}`);

    // ── deposits (fixtures written directly: this suite tests the READ side) ──
    const piRow = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: String(pi.id) }, select: { addressId: true, keyId: true } });
    const dep1 = await prisma.deposit.create({ data: { keyId: piRow.keyId, addressId: piRow.addressId, chain: "TRC20", txHash: `tx${RUN}a`, amount: new Prisma.Decimal("5"), confirmations: 20, status: "confirmed", creditedAt: new Date(), feeAmount: new Prisma.Decimal("0.05") } });
    const dep2 = await prisma.deposit.create({ data: { keyId: piRow.keyId, addressId: piRow.addressId, chain: "TRC20", txHash: `tx${RUN}b`, amount: new Prisma.Decimal("1.25"), confirmations: 2, status: "detected" } });
    const d1 = await call("GET", `/v1/deposits/dep_${dep1.id}`, A.plaintext);
    const d = d1.json;
    check(d1.status === 200 && d.id === `dep_${dep1.id}` && d.object === "deposit" && d.status === "confirmed" && d.amount === "5" && d.tx_hash === `tx${RUN}a` && d.payment_intent_id === pi.id && d.reference === `store-${RUN}-2` && typeof d.confirmed_at === "string" && typeof d.detected_at === "string",
      "§4 GET /deposits/:id renders a Deposit with payment_intent_id", JSON.stringify(d));
    const dA2 = await call("GET", `/v1/deposits/dep_${dep1.id}`, A2.plaintext);
    check(dA2.status === 200 && dA2.json.id === `dep_${dep1.id}`, "A6 another key of the SAME client reads the deposit (reachable after rotation)", `${dA2.status}`);
    const d2 = await call("GET", `/v1/deposits/dep_${dep1.id}`, B.plaintext);
    const d3 = await call("GET", `/v1/deposits/nope_${RUN}`, B.plaintext);
    const dUnprefixed = await call("GET", `/v1/deposits/${dep1.id}`, A.plaintext);
    check(dUnprefixed.status === 404 && dUnprefixed.code === "not_found", "§4 a deposit id is only ever dep_<row id>: the bare row id is 404 not_found", `${dUnprefixed.status}`);
    check(d2.status === 404 && d2.code === "not_found" && d3.status === 404, "§2 another client's deposit is 404, same as unknown", `${d2.status}/${d3.status}`);
    const dl = await call("GET", `/v1/deposits?payment_intent_id=${pi.id}`, A.plaintext);
    const dlB = await call("GET", `/v1/deposits?payment_intent_id=${pi.id}`, B.plaintext);
    check(dl.status === 200 && dl.json.object === "list" && (dl.json.data as unknown[]).length === 2 && dl.json.has_more === false && (dlB.json.data as unknown[]).length === 0,
      "§5 GET /deposits?payment_intent_id= lists both; another client sees none", `${(dl.json.data as unknown[]).length}/${(dlB.json.data as unknown[]).length}`);
    const dlr = await call("GET", `/v1/deposits?reference=store-${RUN}-2&limit=1`, A.plaintext);
    check(dlr.status === 200 && (dlr.json.data as unknown[]).length === 1 && dlr.json.has_more === true, "§5 GET /deposits?reference=&limit=1 → has_more", `${dlr.status}`);
    const dls = await call("GET", `/v1/deposits?since=not-a-date`, A.plaintext);
    check(dls.status === 400 && dls.code === "validation_failed", "§5 GET /deposits?since=garbage is validation_failed", `${dls.status} ${dls.code}`);
    const NODEP = await iss(cA.id, "no-deposits", ["payment_intents.read"]);
    const dro = await call("GET", `/v1/deposits/dep_${dep1.id}`, NODEP.plaintext);
    check(dro.status === 403 && dro.json.error?.details?.required === "deposits.read", "§6 403 insufficient_scope — GET deposit without deposits.read", `${dro.status}`);
    const g4 = await call("GET", `/v1/payment-intents/${pi.id}`, A.plaintext);
    check(g4.json.amount_received === "5" && g4.json.fee_amount === "0.05" && JSON.stringify(g4.json.tx_hashes) === JSON.stringify([`tx${RUN}a`]),
      "§4 amount_received / fee_amount / tx_hashes come from CONFIRMED deposits only (a detected one does not count)", `${g4.json.amount_received} ${g4.json.fee_amount} ${JSON.stringify(g4.json.tx_hashes)}`);
    void dep2;

    // ── events ──
    const evt = { id: `evt_${RUN}`, object: "event", api_version: "2026-09-24", type: "payment_intent.succeeded", created_at: new Date().toISOString(), data: { object: { id: pi.id } } };
    setGetEvent(async (clientId, id) => (clientId === cA.id && id === evt.id ? evt : null));
    const e1 = await call("GET", `/v1/events/${evt.id}`, A.plaintext);
    const e2 = await call("GET", `/v1/events/${evt.id}`, B.plaintext);
    const e3 = await call("GET", `/v1/events/evt_nope`, A.plaintext);
    check(e1.status === 200 && JSON.stringify(e1.json) === JSON.stringify(evt), "§5 GET /events/:id returns the envelope from getEvent(clientId, id)", `${e1.status}`);
    check(e2.status === 404 && e2.code === "not_found" && e3.status === 404, "§2 another client's event is 404, same as unknown", `${e2.status}/${e3.status}`);

    // ── §6 429 ──
    const rl = [] as Array<{ status: number; retry: string | null; code?: string }>;
    for (let i = 0; i < 4; i++) { const r = await call("GET", "/v1/payment-intents", SLOW.plaintext); rl.push({ status: r.status, retry: r.res.headers.get("retry-after"), ...(r.code ? { code: r.code } : {}) }); }
    const limited = rl.filter((r) => r.status === 429);
    check(limited.length >= 1 && limited.every((r) => r.code === "rate_limited" && Number(r.retry) >= 1) && rl[0]?.status === 200, "§6 429 rate_limited with Retry-After (rps_limit=2, 4 quick calls)", JSON.stringify(rl));
    await sleep(1100);
    const rl2 = await call("GET", "/v1/payment-intents", SLOW.plaintext);
    check(rl2.status === 200, "§2 the bucket refills: after 1 s the key is served again", `${rl2.status}`);

    // ── §5 routing ──
    const nf = await call("GET", "/v1/nope", A.plaintext);
    check(nf.status === 404 && nf.code === "not_found" && !!nf.json.error?.request_id, "§6 404 not_found — unknown route under /v1, error shape with request_id", `${nf.status}`);
    // ── /v1/health (A2/A9) ──
    const h0 = await call("GET", "/v1/health", null);
    const lw0 = h0.json.legacy_watch as Record<string, unknown> | undefined;
    check(h0.status === 200 && h0.json.vault === "unproven" && h0.json.derivation === "unavailable" && !!lw0 && "TRC20" in lw0 && "BEP20" in lw0 && typeof h0.json.observer_lag_blocks === "object",
      "A9 GET /v1/health needs no key; unwired readers answer the SAFE values (unproven / unavailable)", JSON.stringify(h0.json));
    const hadCursor = await prisma.scanCursor.findUnique({ where: { chain: "TRC20" } });
    const stamp = new Date("2026-09-24T12:00:00.000Z");
    if (hadCursor) await prisma.scanCursor.update({ where: { chain: "TRC20" }, data: { legacyWatchEnabledAt: stamp } });
    else await prisma.scanCursor.create({ data: { chain: "TRC20", lastScannedBlock: 1n, legacyWatchEnabledAt: stamp } });
    const h1 = await call("GET", "/v1/health", null);
    if (hadCursor) await prisma.scanCursor.update({ where: { chain: "TRC20" }, data: { legacyWatchEnabledAt: hadCursor.legacyWatchEnabledAt } });
    else await prisma.scanCursor.delete({ where: { chain: "TRC20" } });
    check((h1.json.legacy_watch as Record<string, unknown> | undefined)?.TRC20 === stamp.toISOString() && (h1.json.legacy_watch as Record<string, unknown> | undefined)?.BEP20 === null,
      "A2 legacy_watch reports scan_cursors.legacy_watch_enabled_at per chain", JSON.stringify(h1.json.legacy_watch));
    setHealthReaders({ observerLagBlocks: async () => ({ TRC20: 3, BEP20: 7 }), vault: async () => "proven", derivation: async () => "ready" });
    const h2 = await call("GET", "/v1/health", null);
    check(h2.json.ok === true && h2.json.vault === "proven" && h2.json.derivation === "ready" && JSON.stringify(h2.json.observer_lag_blocks) === JSON.stringify({ TRC20: 3, BEP20: 7 }),
      "A9 wired readers are reported as-is", JSON.stringify(h2.json));
    setHealthReaders({ legacyWatch: async () => { throw new Error("db down"); } });
    const h3 = await call("GET", "/v1/health", null);
    check(h3.status === 200 && h3.json.ok === false && !("legacy_watch" in h3.json), "A2 a failing legacy_watch reader is ok:false and the field is ABSENT (never a null that reads as 'not watching')", JSON.stringify(h3.json));
    const hRoot = await call("GET", "/health", null);
    check(hRoot.status === 200, "unversioned /health stays for supervision", `${hRoot.status}`);

    // ── /v1/addresses (A9, M-6) ──
    const aRef = `samaprime:m${RUN}:user:u1`;
    const ad1 = await call("POST", "/v1/addresses", A.plaintext, { chain: "TRC20", reference: aRef }, idem());
    check(ad1.status === 201 && ad1.json.object === "address" && ad1.json.chain === "TRC20" && ad1.json.reference === aRef && typeof ad1.json.address === "string" && Object.keys(ad1.json).length === 4,
      "M-6 POST /v1/addresses → 201 {object:\"address\", chain, address, reference}", JSON.stringify(ad1.json));
    const ad2 = await call("POST", "/v1/addresses", A2.plaintext, { chain: "TRC20", reference: aRef }, idem());
    check(ad2.status === 200 && ad2.json.address === ad1.json.address, "A6 same (client, chain, reference) from ANOTHER key of the client → 200, the same address", `${ad2.status}`);
    const ad3 = await call("POST", "/v1/addresses", B.plaintext, { chain: "TRC20", reference: aRef }, idem());
    check(ad3.status === 201 && ad3.json.address !== ad1.json.address, "A6 another client with the same reference gets its OWN address", `${ad3.status}`);
    const ad4 = await call("POST", "/v1/addresses", A.plaintext, { chain: "TRC20", reference: `payment_intent:${pi.id}` }, idem());
    check(ad4.status === 422 && ad4.code === "reference_invalid", "A9 an intent address's reference (payment_intent:<pi>) can never be requested — 422 reference_invalid", `${ad4.status} ${ad4.code}`);
    const ad5 = await call("POST", "/v1/addresses", A.plaintext, { chain: "ETH", reference: aRef }, idem());
    const ad6 = await call("POST", "/v1/addresses", T.plaintext, { chain: "BEP20", reference: aRef }, idem());
    check(ad5.status === 422 && ad5.code === "unsupported_chain" && ad6.status === 422 && ad6.code === "unsupported_chain", "A9 unsupported / not-enabled chain → 422 unsupported_chain", `${ad5.code}/${ad6.code}`);
    const ad7 = await call("POST", "/v1/addresses", A.plaintext, { chain: "TRC20" }, idem());
    check(ad7.status === 400 && ad7.code === "validation_failed" && (ad7.json.error?.details?.fields as string[] | undefined)?.includes("reference") === true, "M-6 missing reference → 400 validation_failed (not the legacy invalid_input)", `${ad7.status} ${ad7.code}`);
    const ad8 = await call("POST", "/v1/addresses", RO.plaintext, { chain: "TRC20", reference: aRef }, idem());
    check(ad8.status === 403 && ad8.json.error?.details?.required === "addresses.write", "§6 403 insufficient_scope — addresses without addresses.write", `${ad8.status}`);
    deriverDown = true;
    const ad9 = await call("POST", "/v1/addresses", A.plaintext, { chain: "BEP20", reference: aRef }, idem());
    deriverDown = false;
    check(ad9.status === 503 && ad9.code === "derivation_unavailable", "§6 503 derivation_unavailable — POST /addresses with no deriver; nothing created", `${ad9.status} ${ad9.code}`);
    const kAd = idem();
    deriveDelayMs = 500; // both requests pass the pre-check before either writes
    const [ra, rb] = await Promise.all([
      call("POST", "/v1/addresses", A.plaintext, { chain: "BEP20", reference: `samaprime:m${RUN}:user:race` }, kAd),
      call("POST", "/v1/addresses", A2.plaintext, { chain: "BEP20", reference: `samaprime:m${RUN}:user:race` }, idem()),
    ]);
    deriveDelayMs = 0;
    const raceRowsList = await prisma.address.findMany({ where: { reference: `samaprime:m${RUN}:user:race` }, select: { clientId: true } });
    const raceRows = raceRowsList.length;
    check(ra.json.address === rb.json.address && raceRows === 1 && raceRowsList[0]?.clientId === cA.id && [ra.status, rb.status].sort().join() === "200,201",
      "A7 two concurrent POST /addresses for one (client, chain, reference) → ONE address with client_id set, one 201 + one 200 (per-reference advisory lock; G6 UNIQUE is the backstop)", `${ra.status}/${rb.status} rows=${raceRows} client_id=${raceRowsList[0]?.clientId === cA.id ? "caller's" : String(raceRowsList[0]?.clientId)}`);

    // ── Phase 0: withdrawals refuse (A9 gate) ──
    const wBefore = await prisma.withdrawal.count();
    const w1 = await call("POST", "/v1/withdrawals", A.plaintext, { to: "T" + "x".repeat(33), amount: "1", chain: "TRC20" }, idem());
    const w2 = await call("POST", "/withdrawals", A.plaintext, { to: "T" + "x".repeat(33), amount: "1", chain: "TRC20" }, idem());
    const w3 = await call("GET", "/v1/withdrawals/x", A.plaintext);
    const wAfter = await prisma.withdrawal.count();
    check(w1.status === 404 && w2.status === 404 && w3.status === 404 && wAfter === wBefore, "A9 GATE — Phase 0 has no withdrawal route: POST /v1/withdrawals and /withdrawals are 404 and no withdrawal row is written", `${w1.status}/${w2.status}/${w3.status} rows ${wBefore}→${wAfter}`);

    // ── §2 test keys refused in production (Q M2). This suite runs with CRYPTO_MODE=mainnet. ──
    const TK = await issueKey({ clientId: cA.id, name: "test-env", scopes: ["payment_intents.read"], environment: "test", issuedBy: "verify", issuedVia: "cli" }); made.keys.push(TK.id);
    const tk = await call("GET", "/v1/payment-intents", TK.plaintext);
    check(tk.status === 401 && tk.code === "invalid_key", "§2 an sk_test_ key is refused (401 invalid_key) when running in production mode", `${tk.status} ${tk.code}`);

    // ── pre-argon2 brake (Q M1): a flood of wrong secrets on one known prefix ──
    const BR = await iss(cA.id, "brake", ALL);
    await prisma.clientKey.update({ where: { id: BR.id }, data: { rpsLimit: 100_000 } });
    const brWrong = BR.plaintext.slice(0, 12) + "z".repeat(BR.plaintext.length - 12);
    const brakeCodes: string[] = [];
    for (let i = 0; i < 12; i++) brakeCodes.push(String((await call("GET", "/v1/payment-intents", brWrong)).code));
    const brRight = await call("GET", "/v1/payment-intents", BR.plaintext);
    check(brakeCodes.slice(0, 10).every((x) => x === "invalid_key") && brakeCodes.slice(10).every((x) => x === "rate_limited") && brRight.status === 429 && Number(brRight.res.headers.get("retry-after")) >= 1,
      "Q-M1 after 10 failed verifies on one prefix the prefix is 429 BEFORE argon2 (the real holder too, while it lasts — the stated trade-off)", brakeCodes.join(","));
    const brOther = await call("GET", "/v1/payment-intents", A.plaintext);
    check(brOther.status === 200, "Q-M1 the brake is per prefix: other keys are unaffected", `${brOther.status}`);

    // ── ONE RENDERER GATE (lead ruling): the event snapshot IS the REST body ──
    // Real observer (G2) + real enqueueEvent/getEvent (G3) + the fake chain.
    const { observeChain } = await import("@/observer/index.js");
    const { setEventSink } = await import("@/intents/index.js");
    const { enqueueEvent, getEvent } = await import("@/events/index.js");
    setEventSink(enqueueEvent);
    setGetEvent(getEvent as (c: string, id: string) => Promise<Record<string, unknown> | null>);
    const gatePi = await call("POST", "/v1/payment-intents", A.plaintext, { ...good, reference: `store-${RUN}-gate` }, idem());
    gateTransfers.push({ chain: "TRC20", txHash: `gatetx${RUN}a`, toAddress: String(gatePi.json.address), amount: "12.5", blockNumber: 10n, confirmations: 19 });
    gateTransfers.push({ chain: "TRC20", txHash: `gatetx${RUN}b`, toAddress: String(ad1.json.address), amount: "3.25", blockNumber: 10n, confirmations: 19 });
    const gateObserver = { async scan() { return gateTransfers; }, async confirmationsFor() { return 19; } };
    await observeChain("TRC20", gateObserver, 19);
    await observeChain("TRC20", gateObserver, 19);
    for (const [tx, label] of [[`gatetx${RUN}a`, "an intent deposit"], [`gatetx${RUN}b`, "a top-up deposit"]] as const) {
      const row = await prisma.deposit.findFirst({ where: { txHash: tx }, select: { id: true } });
      const rest = await call("GET", `/v1/deposits/dep_${row?.id}`, A.plaintext);
      const ev = await prisma.event.findFirst({ where: { objectId: `dep_${row?.id}`, type: "deposit.confirmed" }, select: { id: true } });
      const got = ev ? await call("GET", `/v1/events/${ev.id}`, A.plaintext) : null;
      const snap = (got?.json.data as { object?: unknown } | undefined)?.object;
      check(rest.status === 200 && got?.status === 200 && isDeepStrictEqual(snap, rest.json), `GATE — ${label}: deposit.confirmed data.object DEEP-EQUALS GET /v1/deposits/:id`, `event=${JSON.stringify(snap)} rest=${rest.text}`);
    }
    const piRest = await call("GET", `/v1/payment-intents/${gatePi.json.id}`, A.plaintext);
    const piEv = await prisma.event.findFirst({ where: { objectId: String(gatePi.json.id), type: "payment_intent.succeeded" }, select: { id: true } });
    const piGot = piEv ? await call("GET", `/v1/events/${piEv.id}`, A.plaintext) : null;
    const piSnap = (piGot?.json.data as { object?: unknown } | undefined)?.object;
    check(piRest.json.status === "succeeded" && piGot?.status === 200 && isDeepStrictEqual(piSnap, piRest.json), "GATE — payment_intent.succeeded data.object DEEP-EQUALS GET /v1/payment-intents/:id", `event=${JSON.stringify(piSnap)} rest=${piRest.text}`);
    const piEvB = piEv ? await call("GET", `/v1/events/${piEv.id}`, B.plaintext) : { status: 0 };
    check(piEvB.status === 404, "§2 the real getEvent: another client's event is 404", `${piEvB.status}`);
  } catch (err) {
    fail++;
    console.error(`\n*** THE SUITE THREW — nothing below this point ran ***\n`, err);
  } finally {
    const keys = { in: made.keys };
    await prisma.webhookDelivery.deleteMany({ where: { keyId: keys } }).catch(() => undefined);
    await prisma.event.deleteMany({ where: { clientId: { in: made.clients } } }).catch(() => undefined);
    await prisma.deposit.deleteMany({ where: { keyId: keys } }).catch(() => undefined);
    await prisma.paymentIntent.deleteMany({ where: { clientId: { in: made.clients } } }).catch(() => undefined);
    await prisma.idempotencyKey.deleteMany({ where: { keyId: keys } }).catch(() => undefined);
    await prisma.address.deleteMany({ where: { keyId: keys } }).catch(() => undefined);
    // Keys and clients are PINNED by their audit rows (append-only, FK
    // Restrict) and stay; they are counted and printed, not treated as leaks.
    await prisma.clientKey.deleteMany({ where: { id: keys } }).catch(() => undefined);
    await prisma.client.deleteMany({ where: { id: { in: made.clients } } }).catch(() => undefined);
    const pinned = (await prisma.clientKey.count({ where: { id: keys } })) + (await prisma.client.count({ where: { id: { in: made.clients } } }));
    const left = (await prisma.paymentIntent.count({ where: { clientId: { in: made.clients } } })) + (await prisma.address.count({ where: { keyId: keys } })) + (await prisma.deposit.count({ where: { keyId: keys } })) + (await prisma.idempotencyKey.count({ where: { keyId: keys } }));
    console.log(`\n${pass} passed, ${fail} failed · ${left} left behind (counted) · ${pinned} key/client rows pinned by audit rows (permanent by design)`);
    if (left !== 0) fail++;
    await prisma.$disconnect();
    if (pass + fail === 0) { console.log("*** VOID — no check executed. This is NOT a pass. ***"); process.exit(1); }
    process.exit(fail === 0 ? 0 : 1);
  }
}
main().catch((e) => { console.error("verify-api-contract crashed:", e); process.exit(1); });
