// COVERS: src/intents/create.ts src/intents/advance.ts src/intents/sweep.ts src/intents/render.ts src/intents/events-port.ts src/observer/index.ts src/worker/intents-expire.ts src/chain/derivation-floor.ts
//
// PHASE 0, G2 — the intents engine, RED-FIRST, on a disposable cluster with
// FAKE chain adapters only (no RPC, no seed: the fake deriver hands out
// synthetic addresses at the index the live deriver would pick).
//
//   bash /www/wwwroot/samaprime.com/scripts/throwaway-pg.sh \
//     ./node_modules/.bin/tsx scripts/throwaway-sandbox.ts scripts/verify-intent-engine.ts
//
// What it proves, each against the database the observer really writes:
//  A. createIntent: a fresh address strictly ABOVE the floor; refusals
//     (floor unset, deriver at the floor, deriver unavailable, amount/chain/
//     reference) create NOTHING.
//  B. observer hook: on-time / over / under→expired_partial→late completion /
//     late on a never-paid intent / expired with nothing / detection-time rule.
//  C. exactly ONE payment_intent.* event per (intent, type) under concurrent
//     ticks — counted as enqueueEvent CALLS, not only as rows, so the unique
//     index cannot hide a second emission.
//  D. an address with watch_disabled_at set is ignored; a non-intent address
//     keeps today's deposit.confirmed and an intent address does not get one.
//  E. the event sink unwired → the transition rolls back (fail closed).
//  L. (A11) a tick and a concurrent cursor rewind+legacy-enable never
//     interleave: the tick holds the cursor advisory lock, so the rewound
//     range is scanned for the legacy address instead of being skipped.
//  R. (Q B1) through the REAL src/chain/live.ts: a transfer whose insert
//     fails once is NOT behind the cursor — the next tick records it.
//  P. a poison transfer is quarantined into scan_gaps after 3 failed ticks;
//     the good transfer behind it is recorded and the cursor moves on.
//  S. (Q M1) 200 abandoned intents do not starve a newer one (sweep + expiry).
//  W. (Q H2) the worker's composition root refuses to boot with a port unwired.
//  M. (A7) amounts truncated to 6 dp (never half-up); a zero deposit never
//     moves an intent; (A1) deposit.confirmed for every deposit with the fee.
import { Prisma, type Chain } from "@prisma/client";
import { assertSandboxDatabase } from "@/db/guard.js";
import { prisma } from "@/db/client.js";
import { chainAdapters, ChainUnavailable, setChainAdapters } from "@/chain/registry.js";
import { nextIndexAboveFloor } from "@/chain/derivation-floor.js";
import type { ObservedTransfer } from "@/chain/types.js";
import { observeChain } from "@/observer/index.js";
import { expireIntentsOnce } from "@/worker/intents-expire.js";
import { advanceIntent, createIntent, setEventSink, type EnqueueEventInput, type IntentStatus } from "@/intents/index.js";
import { enqueueEvent } from "@/events/index.js";
import { legacyWatchStatus, observerLagBlocks } from "@/observer/index.js";
import { liveObserver } from "@/chain/live.js";
import { tronAdapter } from "@/chain/impl/tron.js";
import { DEPOSIT_RENDER_SELECT, renderDeposit } from "@/render/deposit.js";
import { advanceIntentsForChain } from "@/intents/index.js";
import { getChainConfig } from "@/chain/impl/config.js";
import { check, checkOver, summary, thrown } from "./lib/check.js";

const RUN = Date.now().toString(36);
const CHAIN: Chain = "TRC20";
const FLOOR = 1000;
const REQ = 19; // the threshold observeChain is TOLD; config resolution is another suite's subject
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── fakes ──────────────────────────────────────────────────────────────────
type DeriverMode = "normal" | "at_floor" | "unavailable";
let deriverMode: DeriverMode = "normal";
let seq = 0;
const queue: ObservedTransfer[] = [];
const confs = new Map<string, number>();
let block = 1n;
setChainAdapters({
  deriver: {
    async deriveNext(chain) {
      if (deriverMode === "unavailable") throw new ChainUnavailable(`deriveNext(${chain})`);
      if (deriverMode === "at_floor") return { chain, address: `TFLOOR${RUN}`, derivationIndex: FLOOR };
      const highest = await prisma.address.findFirst({ where: { chain }, orderBy: { derivationIndex: "desc" }, select: { derivationIndex: true } });
      const i = nextIndexAboveFloor(highest?.derivationIndex ?? null, FLOOR);
      return { chain, address: `TFAKE${RUN}x${i}x${seq++}`, derivationIndex: i };
    },
  },
  observer: {
    // Like a real scan: transfers to the addresses it was GIVEN, each once (the cursor moves past everything).
    async scan(_chain, addresses) { const out = queue.filter((t) => addresses.has(t.toAddress)); queue.length = 0; return out; },
    async confirmationsFor(_chain, txHash) { return confs.get(txHash) ?? 20; },
  },
});
function pay(to: string, amount: string, confirmations = 20): string {
  const txHash = `tx_${RUN}_${seq++}`;
  queue.push({ chain: CHAIN, txHash, toAddress: to, amount, blockNumber: block++, confirmations });
  confs.set(txHash, confirmations);
  return txHash;
}

// G3's REAL enqueueEvent (merged from origin/p0/g3), wrapped so every CALL is
// recorded — a second emission shows even when the unique index hides the row.
const calls: EnqueueEventInput[] = [];
async function fakeEnqueue(tx: Prisma.TransactionClient, e: EnqueueEventInput) {
  calls.push(e);
  return enqueueEvent(tx, e);
}
const callsFor = (id: string, type?: string) => calls.filter((c) => c.objectId === id && (!type || c.type === type));
const rowsFor = (id: string) => prisma.event.findMany({ where: { objectId: id }, select: { type: true, snapshot: true } });
const statusOf = async (id: string) => (await prisma.paymentIntent.findUniqueOrThrow({ where: { id }, select: { status: true } })).status as IntentStatus;
const tick = () => observeChain(CHAIN, chainAdapters().observer, REQ);

async function main() {
  console.log(`database: ${await assertSandboxDatabase()}`);
  process.env.SAMAPAY_DERIVATION_FLOOR_TRC20 = String(FLOOR);
  process.env.SAMAPAY_DERIVATION_FLOOR_BEP20 = String(FLOOR);
  setEventSink(fakeEnqueue);

  // ── R. B1 through the REAL live scanner (Q's probe) — first, so the one-shot trigger meets our insert ──
  console.log("\nR. cursor is advanced only AFTER the transfers are recorded (real live.ts)");
  {
    process.env.CRYPTO_MODE = "mainnet";
    const rc = await prisma.client.create({ data: { name: `verify-probe-${RUN}`, kind: "merchant" }, select: { id: true } });
    const rk = await prisma.clientKey.create({ data: { clientId: rc.id, name: "probe", keyPrefix: `vpr_${RUN}`.slice(0, 12).padEnd(12, "x"), keyHash: "x", keyLast4: "0000", scopes: [], environment: "test", issuedBy: "verify", issuedVia: "cli" }, select: { id: true } });
    const ADDR = `TQprobe${RUN}`; const TX = `probe${RUN}`.padEnd(64, "0");
    await prisma.address.create({ data: { keyId: rk.id, clientId: rc.id, reference: `probe:m:user:${RUN}`, chain: "TRC20", address: ADDR, derivationIndex: 900_000 } });
    await prisma.scanCursor.upsert({ where: { chain: "TRC20" }, create: { chain: "TRC20", lastScannedBlock: 100n }, update: { lastScannedBlock: 100n } });
    const t = tronAdapter as unknown as Record<string, unknown>;
    const saved = { getLatestBlock: t.getLatestBlock, getConfirmations: t.getConfirmations, getIncomingTransfers: t.getIncomingTransfers };
    t.getLatestBlock = async () => 1000n;
    t.getConfirmations = async () => 0;
    t.getIncomingTransfers = async (from: bigint, to: bigint, addrs: Set<string>) => ({
      transfers: 150n >= from && 150n <= to && addrs.has(ADDR) ? [{ txHash: TX, toAddress: ADDR, amountRaw: "5000000", blockNumber: 150n }] : [],
      scannedThrough: to,
    });
    // ONE-SHOT: a sequence, because nextval() survives the rollback the RAISE causes (a marker ROW would be
    // rolled back with it and the "transient" failure would fire for ever).
    await prisma.$executeRawUnsafe(`CREATE SEQUENCE g2_probe_seq`);
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION g2_probe_fail_once() RETURNS trigger AS $$ BEGIN IF nextval('g2_probe_seq') = 1 THEN RAISE EXCEPTION 'g2 probe: transient failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER g2_probe_trg BEFORE INSERT ON deposits FOR EACH ROW EXECUTE FUNCTION g2_probe_fail_once()`);
    const cur = async () => (await prisma.scanCursor.findUniqueOrThrow({ where: { chain: "TRC20" }, select: { lastScannedBlock: true } })).lastScannedBlock;
    const t1 = await thrown(() => observeChain("TRC20", liveObserver, REQ));
    const c1 = await cur();
    const t2 = await thrown(() => observeChain("TRC20", liveObserver, REQ));
    const c2 = await cur();
    const rows = await prisma.deposit.count({ where: { txHash: TX } });
    await prisma.$executeRawUnsafe(`DROP TRIGGER g2_probe_trg ON deposits`);
    Object.assign(t, saved);
    check(t1.name !== "NO THROW" && c1 === 100n, "R1. the insert fails once → the tick throws and the cursor STAYS at 100 (not advanced past block 150)", `tick ${t1.name}, cursor ${c1}`);
    check(t2.name === "NO THROW" && rows === 1 && c2 === 1000n - BigInt(getChainConfig("TRC20").confirmationsRequired) + 1n, "R2. the next tick re-scans, records the 5 USDT transfer, THEN advances the cursor to the safe head", `tick ${t2.name}, rows ${rows}, cursor ${c2}`);
  }

  // ── P. a POISON transfer (deterministic insert failure) is quarantined, the batch goes on ──
  console.log("\nP. poison transfer → scan_gaps after 3 ticks; the good transfer behind it is recorded");
  {
    process.env.CRYPTO_MODE = "mainnet";
    const pc = await prisma.client.create({ data: { name: `verify-poison-${RUN}`, kind: "merchant" }, select: { id: true } });
    const pk = await prisma.clientKey.create({ data: { clientId: pc.id, name: "poison", keyPrefix: `vpo_${RUN}`.slice(0, 12).padEnd(12, "x"), keyHash: "x", keyLast4: "0000", scopes: [], environment: "test", issuedBy: "verify", issuedVia: "cli" }, select: { id: true } });
    const ADDR = `TQpoison${RUN}`; const BAD = `poisonbad${RUN}`.padEnd(64, "0"); const GOOD = `poisongood${RUN}`.padEnd(64, "0");
    await prisma.address.create({ data: { keyId: pk.id, clientId: pc.id, reference: `probe:m:user:p${RUN}`, chain: "TRC20", address: ADDR, derivationIndex: 900_001 } });
    await prisma.scanCursor.upsert({ where: { chain: "TRC20" }, create: { chain: "TRC20", lastScannedBlock: 1000n }, update: { lastScannedBlock: 1000n } });
    const t = tronAdapter as unknown as Record<string, unknown>;
    const saved = { getLatestBlock: t.getLatestBlock, getConfirmations: t.getConfirmations, getIncomingTransfers: t.getIncomingTransfers };
    t.getLatestBlock = async () => 2000n;
    t.getConfirmations = async () => 0;
    t.getIncomingTransfers = async (from: bigint, to: bigint, addrs: Set<string>) => ({
      transfers: [
        { txHash: BAD, toAddress: ADDR, amountRaw: "12x", blockNumber: 1100n }, // malformed: fails every time
        { txHash: GOOD, toAddress: ADDR, amountRaw: "7000000", blockNumber: 1200n },
      ].filter((x) => x.blockNumber >= from && x.blockNumber <= to && addrs.has(x.toAddress)),
      scannedThrough: to,
    });
    const cur = async () => (await prisma.scanCursor.findUniqueOrThrow({ where: { chain: "TRC20" }, select: { lastScannedBlock: true } })).lastScannedBlock;
    const ticks: string[] = []; const cursors: bigint[] = [];
    for (let k = 0; k < 4; k++) { ticks.push((await thrown(() => observeChain("TRC20", liveObserver, REQ))).name); cursors.push(await cur()); }
    Object.assign(t, saved);
    const safe = 2000n - BigInt(getChainConfig("TRC20").confirmationsRequired) + 1n;
    const good = await prisma.deposit.count({ where: { txHash: GOOD } });
    const gaps = await prisma.scanGap.findMany({ where: { chain: "TRC20", reason: "poison_transfer", evidence: { contains: BAD } }, select: { fromBlock: true, toBlock: true, closedAt: true, evidence: true } });
    check(ticks[0] !== "NO THROW" && ticks[1] !== "NO THROW" && cursors[0] === 1000n && cursors[1] === 1000n, "P1. ticks 1-2: the poison transfer fails, the tick throws, the cursor HOLDS (record-first still wins below the threshold)", `${ticks.slice(0, 2).join(",")} cursor ${cursors.slice(0, 2).join(",")}`);
    check(ticks[2] === "NO THROW" && good === 1 && cursors[2] === safe, "P2. tick 3: the poison is quarantined, the GOOD transfer behind it is recorded, the cursor moves on", `${ticks[2]}, good rows ${good}, cursor ${cursors[2]}`);
    check(gaps.length === 1 && gaps[0]?.fromBlock === 1100n && gaps[0]?.toBlock === 1100n && gaps[0]?.closedAt === null && (gaps[0]?.evidence ?? "").includes("12x"), "P3. exactly ONE open scan_gaps row at block 1100 carrying the tx and the error evidence (existing columns only)", JSON.stringify(gaps.map((g) => ({ f: g.fromBlock.toString(), open: g.closedAt === null }))));
  }

  const client = await prisma.client.create({ data: { name: `verify-intents-${RUN}`, kind: "merchant", enabledChains: ["TRC20"], feeBps: 100 }, select: { id: true } });
  const key = await prisma.clientKey.create({ data: { clientId: client.id, name: "intents", keyPrefix: `vie_${RUN}`.slice(0, 12).padEnd(12, "x"), keyHash: "not-a-real-hash", keyLast4: "0000", scopes: [], environment: "test", issuedBy: "verify", issuedVia: "cli" }, select: { id: true } });
  const mk = (amount: string, opts: { createdAgoSec?: number; expiresInSec?: number; reference?: string } = {}) =>
    createIntent(client.id, key.id, { amount, chain: CHAIN, reference: opts.reference ?? `ord_${RUN}_${seq++}`, expiresInSec: opts.expiresInSec ?? 3600 }, new Date(Date.now() - (opts.createdAgoSec ?? 0) * 1000));
  const counts = async () => ({ a: await prisma.address.count(), i: await prisma.paymentIntent.count() });

  // ── A. createIntent ──────────────────────────────────────────────────────
  console.log("\nA. createIntent — fresh address above the floor, refusals create nothing");
  const i1 = await mk("12.5");
  const a1 = await prisma.address.findUniqueOrThrow({ where: { chain_address: { chain: CHAIN, address: i1.address.address } }, select: { derivationIndex: true, reference: true, keyId: true } });
  check(i1.status === "requires_payment" && a1.derivationIndex > FLOOR && a1.keyId === key.id, "A1. intent created on a fresh address strictly above the floor", `index ${a1.derivationIndex} > ${FLOOR}`);
  check(a1.reference === `payment_intent:${i1.id}`, "A2. the intent address's reference is payment_intent:<id> — POST /addresses can never hand it out", a1.reference);
  const i1b = await mk("12.5");
  check(i1b.address.address !== i1.address.address, "A3. a second intent gets a DIFFERENT address (never reused)");

  let before = await counts();
  delete process.env.SAMAPAY_DERIVATION_FLOOR_TRC20;
  let r = await thrown(() => mk("5"));
  process.env.SAMAPAY_DERIVATION_FLOOR_TRC20 = String(FLOOR);
  let after = await counts();
  check(r.name === "DerivationUnavailable" && after.a === before.a && after.i === before.i, "A4. floor NOT configured → DerivationUnavailable, nothing created", r.name);

  deriverMode = "at_floor"; before = await counts();
  r = await thrown(() => mk("5"));
  deriverMode = "normal"; after = await counts();
  check(r.name === "DerivationUnavailable" && after.a === before.a && after.i === before.i, "A5. a deriver that returns index = floor is REFUSED at persist time, nothing created", r.name);

  deriverMode = "unavailable"; before = await counts();
  r = await thrown(() => mk("5"));
  deriverMode = "normal"; after = await counts();
  check(r.name === "DerivationUnavailable" && after.a === before.a && after.i === before.i, "A6. deriver unavailable (seed locked / not wired) → DerivationUnavailable, nothing created", r.name);

  for (const bad of ["0", "0.5", "10000.000001", "1.0000001", "20000"]) {
    before = await counts(); r = await thrown(() => mk(bad)); after = await counts();
    check(r.name === "AmountOutOfRange" && after.i === before.i && after.a === before.a, `A7. amount ${bad} → AmountOutOfRange (min 1, max 10000, ≤ 6 dp), nothing created`, r.name);
  }
  r = await thrown(() => createIntent(client.id, key.id, { amount: "5", chain: "BEP20", reference: `x_${RUN}` }));
  check(r.name === "UnsupportedChain", "A8. chain not in enabled_chains → UnsupportedChain", r.name);
  r = await thrown(() => mk("5", { reference: "has space" }));
  check(r.name === "ReferenceInvalid", "A9. reference with a space → ReferenceInvalid", r.name);
  r = await thrown(() => mk("5", { expiresInSec: 299 }));
  check(r.name === "IntentInputInvalid", "A10. expires_in_sec 299 → IntentInputInvalid", r.name);
  const edge = await mk("10000"); const edge2 = await mk("1");
  check(edge.amount.eq(10000) && edge2.amount.eq(1), "A11. CONTROL — amounts exactly at min and max are accepted");
  const par = await Promise.all([mk("2"), mk("2"), mk("2")]);
  const parIdx = await prisma.address.findMany({ where: { address: { in: par.map((p) => p.address.address) } }, select: { derivationIndex: true } });
  check(new Set(parIdx.map((x) => x.derivationIndex)).size === 3 && parIdx.every((x) => x.derivationIndex > FLOOR), "A12. 3 concurrent createIntent → 3 distinct indices, all above the floor (a lost index race re-derives)", parIdx.map((x) => x.derivationIndex).join(","));
  const dupRef = `dup_${RUN}`; await mk("2", { reference: dupRef });
  before = await counts(); r = await thrown(() => mk("3", { reference: dupRef })); after = await counts();
  check(r.name === "ReferenceConflict" && after.a === before.a && after.i === before.i, "A14. same (client, reference) again → ReferenceConflict, no index burned, nothing created (A7)", r.name);
  const other = await prisma.client.create({ data: { name: `verify-intents-other-${RUN}`, kind: "merchant" }, select: { id: true } });
  r = await thrown(() => createIntent(other.id, key.id, { amount: "5", chain: CHAIN, reference: `x_${RUN}` }));
  check(r.name === "IntentKeyMismatch", "A13. a key used with ANOTHER client's id → IntentKeyMismatch", r.name);

  // ── E. unwired sink fails closed (run before the other flows use the sink) ──
  console.log("\nE. event sink unwired → the transition does not commit");
  const iE = await mk("3");
  const eAddrId = (await prisma.paymentIntent.findUniqueOrThrow({ where: { id: iE.id }, select: { addressId: true } })).addressId;
  setEventSink(async () => { throw new Error("unwired (test)"); });
  pay(iE.address.address, "3");
  const eTick = await thrown(() => tick());
  let eDep = await prisma.deposit.findFirst({ where: { addressId: eAddrId }, select: { status: true, feeAmount: true } });
  check((await statusOf(iE.id)) === "requires_payment" && eDep?.status === "detected", "E1. sink throws → the deposit is NOT confirmed without its event, intent unchanged (retried next tick)", `deposit ${eDep?.status}, tick ${eTick.name}`);
  // Now only payment_intent.* refuses: the deposit confirms (with its deposit.confirmed), the intent transition rolls back.
  setEventSink(async (tx, e) => { if (e.objectKind === "payment_intent") throw new Error("intent sink down (test)"); return fakeEnqueue(tx, e); });
  await tick();
  setEventSink(fakeEnqueue);
  eDep = await prisma.deposit.findFirst({ where: { addressId: eAddrId }, select: { status: true, feeAmount: true } });
  check((await statusOf(iE.id)) === "requires_payment" && eDep?.status === "confirmed", "E2. intent event refused → deposit confirmed, intent NOT advanced (its transaction rolled back)", `${eDep?.status}`);
  check(eDep?.feeAmount.eq("0.03") === true, "M1. fee_amount stamped at confirmation: 3 × 100 bps = 0.03", eDep?.feeAmount.toFixed());

  // ── C. concurrency: 8 advances racing on the same paid intent ──────────────
  console.log("\nC. exactly one event per (intent, type) under concurrent ticks");
  const race = await Promise.all(Array.from({ length: 8 }, () => advanceIntent(iE.id, { now: new Date(), confirmationsRequired: REQ, actor: "observer" })));
  const advancedN = race.filter((x) => x.outcome === "advanced").length;
  check(advancedN === 1, "C1. 8 concurrent advanceIntent → exactly 1 advanced", race.map((x) => x.outcome).join(","));
  check(callsFor(iE.id, "payment_intent.succeeded").length === 1, "C2. exactly 1 enqueueEvent CALL for payment_intent.succeeded", String(callsFor(iE.id).length));
  check((await rowsFor(iE.id)).length === 1 && (await statusOf(iE.id)) === "succeeded", "C3. exactly 1 event row; intent succeeded");

  const iC = await mk("7");
  pay(iC.address.address, "7");
  await Promise.all([tick(), tick(), tick()]);
  await Promise.all([tick(), tick()]);
  check(callsFor(iC.id).length === 1 && (await rowsFor(iC.id)).length === 1, "C4. 3 then 2 concurrent observer ticks on a paid intent → 1 call, 1 row", `${callsFor(iC.id).length} calls`);

  // ── B. the observer hook ─────────────────────────────────────────────────
  console.log("\nB. observer hook — on time / over / under / late / expired / detection time");
  const iOn = await mk("10");
  const onTx1 = pay(iOn.address.address, "4", 3);
  await tick();
  check((await statusOf(iOn.id)) === "processing" && callsFor(iOn.id).length === 0, "B1. tx seen, under-confirmed → processing, no event");
  confs.set(onTx1, 20);
  pay(iOn.address.address, "6");
  await tick();
  const onRows = await rowsFor(iOn.id);
  const onSnap = onRows[0]?.snapshot as Record<string, unknown> | undefined;
  check((await statusOf(iOn.id)) === "succeeded" && onRows.length === 1 && onRows[0]?.type === "payment_intent.succeeded", "B2. two confirmed partials summing to the amount, on time → succeeded + ONE payment_intent.succeeded");
  check(onSnap?.status === "succeeded" && onSnap?.amount_received === "10" && onSnap?.amount === "10" && Array.isArray(onSnap?.tx_hashes) && (onSnap.tx_hashes as unknown[]).length === 2 && onSnap?.object === "payment_intent" && onSnap?.confirmations_required === REQ, "B3. the snapshot is the contract's object (status, amount_received \"10\", 2 tx_hashes)", JSON.stringify(onSnap));

  const iOver = await mk("10");
  pay(iOver.address.address, "15");
  await tick();
  const overSnap = (await rowsFor(iOver.id))[0]?.snapshot as Record<string, unknown> | undefined;
  check((await statusOf(iOver.id)) === "succeeded" && overSnap?.amount_received === "15", "B4. OVERPAY 15 on 10 → succeeded, amount_received \"15\"", String(overSnap?.amount_received));

  // under → expired_partial (expiry job) → late completion → succeeded_late
  const iUnder = await mk("10", { createdAgoSec: 300 - 4, expiresInSec: 300 }); // expires ~4 s from now
  pay(iUnder.address.address, "4");
  await tick();
  check((await statusOf(iUnder.id)) === "processing", "B5. UNDERPAY in time → processing, no event yet", String(callsFor(iUnder.id).length));
  const exp0 = await expireIntentsOnce({ confirmationsRequired: () => REQ });
  check((await statusOf(iUnder.id)) === "processing", "B6. CONTROL — expiry job BEFORE expires_at leaves it alone", JSON.stringify(exp0));
  await sleep(5_000);
  await expireIntentsOnce({ confirmationsRequired: () => REQ });
  await expireIntentsOnce({ confirmationsRequired: () => REQ });
  const underRows = await rowsFor(iUnder.id);
  check((await statusOf(iUnder.id)) === "expired_partial" && underRows.length === 1 && underRows[0]?.type === "payment_intent.expired" && (underRows[0]?.snapshot as Record<string, unknown>).status === "expired_partial", "B7. past expiry with a partial → expired_partial + ONE payment_intent.expired (job run twice)");
  pay(iUnder.address.address, "6");
  await tick();
  const lateRows = await rowsFor(iUnder.id);
  const lateSucc = lateRows.find((x) => x.type === "payment_intent.succeeded")?.snapshot as Record<string, unknown> | undefined;
  check((await statusOf(iUnder.id)) === "succeeded_late" && lateSucc?.status === "succeeded_late" && lateSucc?.amount_received === "10" && lateSucc?.expired_at !== null, "B8. late completing payment on expired_partial → succeeded_late + payment_intent.succeeded (expired_at kept)", JSON.stringify(lateSucc));
  check(callsFor(iUnder.id, "payment_intent.expired").length === 1 && callsFor(iUnder.id, "payment_intent.succeeded").length === 1, "B9. exactly one call per type on that intent (expired, then succeeded)");

  const iNone = await mk("5", { createdAgoSec: 7200 });
  await expireIntentsOnce({ confirmationsRequired: () => REQ });
  const noneRows = await rowsFor(iNone.id);
  check((await statusOf(iNone.id)) === "expired" && noneRows.length === 1 && (noneRows[0]?.snapshot as Record<string, unknown>).status === "expired", "B10. nothing paid past expiry → expired + ONE payment_intent.expired");
  pay(iNone.address.address, "5");
  await tick();
  check((await statusOf(iNone.id)) === "succeeded_late" && callsFor(iNone.id, "payment_intent.succeeded").length === 1, "B11. a full payment AFTER expired → succeeded_late (money never lost)");

  const iLateDirect = await mk("5", { createdAgoSec: 7200 });
  pay(iLateDirect.address.address, "5");
  await tick();
  check((await statusOf(iLateDirect.id)) === "succeeded_late" && callsFor(iLateDirect.id).length === 1 && callsFor(iLateDirect.id)[0]?.type === "payment_intent.succeeded", "B12. first seen after expiry, never swept → succeeded_late, only a succeeded event");

  // detection-time rule: seen in time, still confirming at expiry → stays processing, then succeeded (not late)
  const iDet = await mk("5", { createdAgoSec: 300 - 3, expiresInSec: 300 });
  const detTx = pay(iDet.address.address, "5", 2);
  await tick();
  await sleep(4_000);
  await expireIntentsOnce({ confirmationsRequired: () => REQ });
  check((await statusOf(iDet.id)) === "processing" && callsFor(iDet.id).length === 0, "B13. in-time tx still confirming at expiry → stays processing, NO expired event");
  confs.set(detTx, 20);
  await tick();
  check((await statusOf(iDet.id)) === "succeeded" && callsFor(iDet.id).length === 1 && callsFor(iDet.id)[0]?.type === "payment_intent.succeeded", "B14. it then confirms → succeeded (on time by DETECTION time), not succeeded_late");

  // ── D. disabled address / non-intent address ─────────────────────────────
  console.log("\nD. watch_disabled_at ignored; deposit.confirmed only for non-intent addresses");
  const iDis = await mk("5");
  await prisma.address.update({ where: { chain_address: { chain: CHAIN, address: iDis.address.address } }, data: { watchDisabledAt: new Date() } });
  const disTx = pay(iDis.address.address, "5");
  await tick();
  const disDep = await prisma.deposit.count({ where: { txHash: disTx } });
  check(disDep === 0 && (await statusOf(iDis.id)) === "requires_payment" && callsFor(iDis.id).length === 0, "D1. deposit to an address with watch_disabled_at → not recorded, intent unchanged, no event", `${disDep} deposit rows`);

  const topup = await prisma.address.create({ data: { keyId: key.id, chain: CHAIN, reference: `samaprime:m1:user:${RUN}`, address: `TTOPUP${RUN}`, derivationIndex: 7 }, select: { id: true } });
  const topTx = pay(`TTOPUP${RUN}`, "2");
  await tick();
  const topDep = await prisma.deposit.findFirst({ where: { txHash: topTx }, select: { id: true, status: true } });
  const topCalls = calls.filter((c) => c.objectId === `dep_${topDep?.id}` && c.type === "deposit.confirmed");
  check(topDep?.status === "confirmed" && topCalls.length === 1 && topCalls[0]?.snapshot.payment_intent_id === null && topCalls[0]?.snapshot.reference === `samaprime:m1:user:${RUN}`, "D2. a non-intent address gets ONE deposit.confirmed (payment_intent_id null, its own reference)", `${topDep?.status}, ${topCalls.length} call(s)`);

  const intentDeps = await prisma.deposit.findMany({ where: { address: { intent: { isNot: null } }, keyId: key.id, status: "confirmed" }, select: { id: true, address: { select: { intent: { select: { id: true } } } } } });
  const everyOne = intentDeps.every((d) => { const c = calls.filter((x) => x.objectId === `dep_${d.id}` && x.type === "deposit.confirmed"); return c.length === 1 && c[0]?.snapshot.payment_intent_id === d.address.intent?.id; });
  checkOver(intentDeps.length, everyOne, "D3. (A1) EVERY confirmed deposit at an intent address has exactly ONE deposit.confirmed carrying its payment_intent_id");
  const depHooks = await prisma.webhookDelivery.findMany({ where: { eventType: "deposit.confirmed" }, select: { eventId: true } });
  const evIds = new Set((await prisma.event.findMany({ where: { type: "deposit.confirmed" }, select: { id: true } })).map((e) => e.id));
  checkOver(depHooks.length, depHooks.every((h) => evIds.has(h.eventId)), "D3b. every deposit.confirmed delivery belongs to an events row (the enqueueEvent path; never the legacy enqueue())");

  // ── M. truncation and zero deposits ─────────────────────────────────────
  console.log("\nM. 6-dp truncation, zero deposits");
  const truncTx = pay(`TTOPUP${RUN}`, "1.0000009");
  await tick();
  const trunc = await prisma.deposit.findFirst({ where: { txHash: truncTx }, select: { amount: true } });
  check(trunc?.amount.toFixed() === "1", "M2. observed 1.0000009 is stored as 1.000000 (truncated, never rounded up to 1.000001)", trunc?.amount.toFixed());
  const iZero = await mk("5");
  pay(iZero.address.address, "0.0000004");
  await tick();
  check((await statusOf(iZero.id)) === "requires_payment" && callsFor(iZero.id).length === 0, "M3. a deposit that truncates to 0 never moves the intent to processing", await statusOf(iZero.id));

  // legacy_import addresses: not watched until the cursor carries legacy_watch_enabled_at (§9 step 5b)
  await prisma.address.create({ data: { keyId: key.id, chain: CHAIN, reference: `samaprime:m1:user:legacy${RUN}`, address: `TLEGACY${RUN}`, derivationIndex: 8, legacyImport: true } });
  const legTx1 = pay(`TLEGACY${RUN}`, "1");
  await tick();
  check((await prisma.deposit.count({ where: { txHash: legTx1 } })) === 0, "D4. legacy_import address, legacy watch NOT enabled → transfer not recorded (MNTAD still owns it)");
  await prisma.scanCursor.upsert({ where: { chain: CHAIN }, create: { chain: CHAIN, lastScannedBlock: 1n, legacyWatchEnabledAt: new Date() }, update: { legacyWatchEnabledAt: new Date() } });
  const legTx2 = pay(`TLEGACY${RUN}`, "1");
  await tick();
  check((await prisma.deposit.count({ where: { txHash: legTx2 } })) === 1, "D5. CONTROL — once legacy_watch_enabled_at is set, the same address is recorded");

  // ── L. cursor lock vs a concurrent rewind + legacy enable (A11) ─────────
  console.log("\nL. a tick and a cursor rewind/enable never interleave");
  const LCH: Chain = "BEP20";
  const legAddr = `0xleg${RUN}`;
  await prisma.address.create({ data: { keyId: key.id, chain: LCH, reference: `samaprime:m1:user:l${RUN}`, address: legAddr, derivationIndex: 9, legacyImport: true } });
  await prisma.scanCursor.upsert({ where: { chain: LCH }, create: { chain: LCH, lastScannedBlock: 100n }, update: { lastScannedBlock: 100n, legacyWatchEnabledAt: null } });
  // A cursor-aware fake chain, shaped like src/chain/live.ts: (cursor, head], then a MONOTONIC advance.
  const chainLog: ObservedTransfer[] = [{ chain: LCH, txHash: `0xlegtx${RUN}`, toAddress: legAddr, amount: "4", blockNumber: 150n, confirmations: 60 }];
  let head = 200n; let hold: Promise<void> | null = null; let scanStarted: () => void = () => {};
  const cursorObserver = {
    async scan(chain: Chain, addrs: ReadonlySet<string>) {
      const cur = (await prisma.scanCursor.findUnique({ where: { chain }, select: { lastScannedBlock: true } }))?.lastScannedBlock ?? 0n;
      const out = chainLog.filter((t) => t.blockNumber > cur && t.blockNumber <= head && addrs.has(t.toAddress));
      if (hold) { scanStarted(); await hold; }
      const moved = await prisma.scanCursor.updateMany({ where: { chain, lastScannedBlock: { lt: head } }, data: { lastScannedBlock: head } });
      void moved;
      return out;
    },
    async confirmationsFor() { return 60; },
  };
  const order: string[] = [];
  let release: () => void = () => {};
  hold = new Promise<void>((r) => { release = r; });
  const started = new Promise<void>((r) => { scanStarted = r; });
  const tickP = observeChain(LCH, cursorObserver, REQ).then(() => { order.push("tick_end"); });
  await started;
  // G5's start-legacy-watch, simulated: the agreed lock name (A11, literal on purpose — it must match G5's src/chain/cursor.ts, not merely this module), rewind (non-monotonic) + enable, one transaction.
  const setP = prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`samapay_scan_cursor:${LCH}`}))`;
    await tx.scanCursor.update({ where: { chain: LCH }, data: { lastScannedBlock: 120n, legacyWatchEnabledAt: new Date() } });
  }).then(() => { order.push("set_end"); });
  await sleep(1_500);
  const setDuringScan = order.includes("set_end");
  hold = null; release();
  await Promise.all([tickP, setP]);
  check(!setDuringScan && order.join(",") === "tick_end,set_end", "L1. the rewind/enable WAITS for the in-flight tick (cursor lock held across the scan)", order.join(","));
  head = 210n;
  await observeChain(LCH, cursorObserver, REQ);
  const legDep = await prisma.deposit.count({ where: { chain: LCH, txHash: `0xlegtx${RUN}` } });
  check(legDep === 1, "L2. the rewound range (120, 200] IS scanned for the now-enabled legacy address — its block-150 deposit is recorded, not skipped", `${legDep} row(s)`);

  // ── client_id written by the new code (A12) and the /v1/health readers (A9) ──
  const myDeps = await prisma.deposit.findMany({ where: { keyId: key.id }, select: { clientId: true } });
  checkOver(myDeps.length, myDeps.every((d) => d.clientId === client.id), "M4. every deposit the observer wrote carries client_id (A12)");
  const myAddrs = await prisma.address.findMany({ where: { keyId: key.id, intent: { isNot: null } }, select: { clientId: true } });
  checkOver(myAddrs.length, myAddrs.every((a) => a.clientId === client.id), "M5. every intent address createIntent wrote carries client_id (A12)");
  const lw = await legacyWatchStatus();
  check(typeof lw.TRC20 === "string" && typeof lw.BEP20 === "string" && !Number.isNaN(Date.parse(lw.BEP20 ?? "")), "H1. legacyWatchStatus() → an ISO string per chain once enabled (G1 health.ts's PerChain<string|null>)", JSON.stringify(lw));
  const lag = await observerLagBlocks(async (c) => (c === "BEP20" ? 250n : 0n));
  check(lag.BEP20 === 40, "H2. observerLagBlocks(head) = head − cursor (BEP20 250 − 210 = 40)", JSON.stringify(lag));

  // ── A13: the webhook snapshot IS G1's renderDeposit of the same row ─────
  const snapCall = calls.find((c) => c.type === "deposit.confirmed" && c.objectId === `dep_${topDep?.id}`);
  const nowRow = await prisma.deposit.findUniqueOrThrow({ where: { id: topDep?.id ?? "" }, select: DEPOSIT_RENDER_SELECT });
  check(JSON.stringify(snapCall?.snapshot) === JSON.stringify(renderDeposit(nowRow)), "D6. (A13) deposit.confirmed snapshot === renderDeposit(row) — the one renderer GET /v1/deposits/:id uses");

  // ── S. starvation (Q M1) ─────────────────────────────────────────────────
  console.log("\nS. 200 abandoned intents never starve a newer one");
  {
    const sc = await prisma.client.create({ data: { name: `verify-starve-${RUN}`, kind: "merchant" }, select: { id: true } });
    const sk = await prisma.clientKey.create({ data: { clientId: sc.id, name: "starve", keyPrefix: `vst_${RUN}`.slice(0, 12).padEnd(12, "x"), keyHash: "x", keyLast4: "0000", scopes: [], environment: "test", issuedBy: "verify", issuedVia: "cli" }, select: { id: true } });
    const old = new Date(Date.now() - 2 * 86_400_000);
    const bulk = async (chain: Chain, base: number, status: "expired_partial" | "processing", dep: "confirmed" | "detected") => {
      const n = 200;
      const ids = Array.from({ length: n }, (_, i) => `pi_s${RUN}${chain}${i}`);
      const addrIds = Array.from({ length: n }, (_, i) => `adr${RUN}${chain}${i}`);
      await prisma.address.createMany({ data: ids.map((id, i) => ({ id: addrIds[i] as string, keyId: sk.id, clientId: sc.id, chain, reference: `payment_intent:${id}`, address: `S${RUN}${chain}${i}`, derivationIndex: base + i })) });
      await prisma.paymentIntent.createMany({ data: ids.map((id, i) => ({ id, clientId: sc.id, keyId: sk.id, addressId: addrIds[i] as string, chain, amount: new Prisma.Decimal(5), reference: `starve_${RUN}_${chain}_${i}`, status, expiresAt: new Date(old.getTime() + 3_600_000), createdAt: old, expiredAt: status === "expired_partial" ? new Date(old.getTime() + 3_600_000) : null })) });
      await prisma.deposit.createMany({ data: ids.map((_, i) => ({ keyId: sk.id, clientId: sc.id, addressId: addrIds[i] as string, chain, txHash: `st${RUN}${chain}${i}`, amount: new Prisma.Decimal(1), confirmations: dep === "confirmed" ? 20 : 1, status: dep, detectedAt: old, creditedAt: dep === "confirmed" ? old : null })) });
    };
    await bulk("TRC20", 700_000, "expired_partial", "confirmed");
    const iNew = await mk("5");
    pay(iNew.address.address, "5");
    await tick();
    for (let k = 0; k < 2 && (await statusOf(iNew.id)) !== "succeeded"; k++) await advanceIntentsForChain(CHAIN, { now: new Date(), confirmationsRequired: REQ });
    check((await statusOf(iNew.id)) === "succeeded", "S1. with 200 older abandoned expired_partial intents open, a newly paid intent still reaches succeeded within ceil(n/200)+1 sweeps", await statusOf(iNew.id));

    await bulk("BEP20", 800_000, "processing", "detected"); // in-time deposits that never confirm: due for ever
    const iDue = await mk("5", { createdAgoSec: 7200 });
    for (let k = 0; k < 3 && (await statusOf(iDue.id)) !== "expired"; k++) await expireIntentsOnce({ confirmationsRequired: () => REQ });
    check((await statusOf(iDue.id)) === "expired", "S2. with 200 older stuck-processing intents due, a newer unpaid intent still expires within ceil(n/200)+1 runs", await statusOf(iDue.id));
  }

  // ── W. composition root (Q H2) ────────────────────────────────────────────
  console.log("\nW. the worker refuses to boot with a port unwired");
  setChainAdapters({ observer: chainAdapters().observer }); // the test fake: NOT the live observer
  // Imported here, not at the top: an entry point that lacks the composition root must FAIL these checks, not crash the suite.
  const worker = (await import("@/worker/index.js")) as { assertWorkerComposed?: () => void; composeWorker?: () => void };
  const w1 = await thrown(async () => { if (!worker.assertWorkerComposed) throw new Error("no assertWorkerComposed exported"); worker.assertWorkerComposed(); });
  check(w1.name === "WorkerNotComposed", "W1. a fake/unwired observer → assertWorkerComposed throws WorkerNotComposed", w1.name);
  const w2 = await thrown(async () => { if (!worker.composeWorker) throw new Error("no composeWorker exported"); worker.composeWorker(); });
  check(w2.name === "NO THROW", "W2. composeWorker() (live adapters + G3's enqueueEvent) passes its own boot assertion", w2.name);

  // ── the floor across everything this run created ───────────────────────
  const intentAddrs = await prisma.address.findMany({ where: { keyId: key.id, intent: { isNot: null } }, select: { derivationIndex: true } });
  checkOver(intentAddrs.length, intentAddrs.every((a) => a.derivationIndex > FLOOR), "F1. every intent address this run created is strictly above the floor");
  void topup;
  process.exit(summary());
}

main().catch((e) => { console.error("verify-intent-engine crashed:", e); process.exit(1); });
