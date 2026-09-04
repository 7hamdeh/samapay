// STEP 4, RED-FIRST — the whole rule through the real app, in-process, with
// injected chain doubles (no chain, no port): issue an address → the observer
// records a transfer → it confirms → /balance shows it → /withdrawals is bounded
// by it → replay is one row → an over-allowance is refused with the three
// unclamped numbers → a second key sees NONE of it (isolation).
import { Prisma } from "@prisma/client";
import { assertSandboxDatabase } from "@/db/guard.js";
import { prisma } from "@/db/client.js";
import { buildApp } from "@/http/app.js";
import { issueKey } from "@/keys/issue.js";
import { setChainAdapters } from "@/chain/registry.js";
import { observeChain, CONFIRMATIONS_REQUIRED } from "@/observer/index.js";
import type { ObservedTransfer } from "@/chain/types.js";

let pass = 0, fail = 0;
function check(ok: boolean, label: string, detail = "") { if (ok) pass++; else fail++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`); }
const RUN = Date.now();

async function main() {
  console.log(`database: ${await assertSandboxDatabase()}`);
  const app = buildApp();
  const made = { clients: [] as string[], keys: [] as string[] };
  // chain doubles: deterministic addresses, a transfer list we control, confirmations we control
  let nextIndex = 1000 + (RUN % 1000) * 10; const transfers: ObservedTransfer[] = []; let confirmations = 0;
  setChainAdapters({
    deriver: { async deriveNext(chain) { const i = nextIndex++; return { chain, address: `0xVERIFY${RUN}${i}`, derivationIndex: i }; } },
    observer: { async scan() { return transfers; }, async confirmationsFor() { return confirmations; } },
    sender: { async send() { return { ok: false, reason: "rejected_pre_broadcast", detail: "verify: no real chain" }; } },
  });
  try {
    const client = await prisma.client.create({ data: { name: `verify-e2e-${RUN}`, kind: "merchant" } }); made.clients.push(client.id);
    const scopes = ["addresses.write", "deposits.read", "withdrawals.write", "withdrawals.read", "balance.read"];
    const A = await issueKey({ clientId: client.id, name: "A", scopes, issuedBy: "verify", issuedVia: "cli" });
    const B = await issueKey({ clientId: client.id, name: "B", scopes, issuedBy: "verify", issuedVia: "cli" });
    made.keys.push(A.id, B.id);
    const hdr = (k: string, idem?: string) => ({ authorization: `Bearer ${k}`, "content-type": "application/json", ...(idem ? { "idempotency-key": idem } : {}) });

    // 1. address issued to A, bound to a reference; same (reference, chain) reuses
    const a1 = await app.request("/addresses", { method: "POST", headers: hdr(A.plaintext, `addr-${RUN}`), body: JSON.stringify({ chain: "BEP20", reference: "cust-1" }) });
    const a1b = (await a1.json()) as { address: { address: string; reused: boolean } };
    const a2 = await app.request("/addresses", { method: "POST", headers: hdr(A.plaintext, `addr2-${RUN}`), body: JSON.stringify({ chain: "BEP20", reference: "cust-1" }) });
    const a2b = (await a2.json()) as { address: { address: string; reused: boolean } };
    check(a1.status === 201 && a2.status === 200 && a2b.address.reused && a2b.address.address === a1b.address.address, "1. POST /addresses issues once per (key, reference, chain); the second call reuses", `${a1.status}/${a2.status}`);
    const noIdem = await app.request("/addresses", { method: "POST", headers: hdr(A.plaintext), body: "{}" });
    check(noIdem.status === 400, "1b. a write without Idempotency-Key is refused 400", `status=${noIdem.status}`);

    // 2. observer records a 10 USDT transfer ONCE even when scanned twice
    transfers.push({ chain: "BEP20", txHash: `0xtx${RUN}`, toAddress: a1b.address.address, amount: "10.000000", blockNumber: 1n, confirmations: 0 });
    const o1 = await observeChain("BEP20", (await import("@/chain/registry.js")).chainAdapters().observer);
    const o2 = await observeChain("BEP20", (await import("@/chain/registry.js")).chainAdapters().observer);
    check(o1.recorded === 1 && o2.recorded === 0 && o2.alreadyKnown === 1, "2. the observer records a transfer once; a second scan sees it as alreadyKnown (UNIQUE chain+tx_hash)", `${JSON.stringify(o1)} then ${JSON.stringify(o2)}`);
    const bal0 = (await (await app.request("/balance", { headers: hdr(A.plaintext) })).json()) as { balance: { received: string; allowance: string } };
    check(bal0.balance.received === "0" && bal0.balance.allowance === "0", "3. a DETECTED deposit does not count: /balance still 0", JSON.stringify(bal0.balance));

    // 4. confirm once; balance moves exactly once
    confirmations = CONFIRMATIONS_REQUIRED.BEP20;
    const o3 = await observeChain("BEP20", (await import("@/chain/registry.js")).chainAdapters().observer);
    const o4 = await observeChain("BEP20", (await import("@/chain/registry.js")).chainAdapters().observer);
    const bal1 = (await (await app.request("/balance", { headers: hdr(A.plaintext) })).json()) as { balance: { received: string; allowance: string; deposit_count: number } };
    check(o3.confirmed === 1 && o4.confirmed === 0 && bal1.balance.received === "10" && bal1.balance.allowance === "10" && bal1.balance.deposit_count === 1, "4. confirmed exactly once; /balance received=10 allowance=10", `confirmed ${o3.confirmed}/${o4.confirmed} balance=${JSON.stringify(bal1.balance)}`);
    const dep = (await (await app.request("/deposits", { headers: hdr(A.plaintext) })).json()) as { deposits: Array<{ status: string; counts_toward_allowance: boolean }> };
    check(dep.deposits.length === 1 && dep.deposits[0]?.status === "confirmed" && dep.deposits[0]?.counts_toward_allowance === true, "4b. GET /deposits shows it confirmed and counting");
    const webhook = await prisma.webhookDelivery.count({ where: { keyId: A.id, eventType: "deposit.confirmed" } });
    check(webhook === 1, "4c. exactly one deposit.confirmed webhook enqueued", `${webhook}`);

    // 5. withdrawal within allowance: 202, balance in body shows the reservation counted
    const w1 = await app.request("/withdrawals", { method: "POST", headers: hdr(A.plaintext, `wd-${RUN}`), body: JSON.stringify({ to: "0x" + "d".repeat(40), amount: "6.5", chain: "BEP20" }) });
    const w1b = (await w1.json()) as { withdrawal: { id: string; status: string; replayed: boolean }; balance: { withdrawn: string; allowance: string } };
    check(w1.status === 202 && w1b.withdrawal.status === "pending" && w1b.balance.withdrawn === "6.5" && w1b.balance.allowance === "3.5", "5. POST /withdrawals 202 pending; body.balance shows withdrawn=6.5 allowance=3.5", `status=${w1.status} ${JSON.stringify(w1b.balance)}`);
    // 5b. replay with the same key = same row, no second reservation
    const w1r = await app.request("/withdrawals", { method: "POST", headers: hdr(A.plaintext, `wd-${RUN}`), body: JSON.stringify({ to: "0x" + "d".repeat(40), amount: "6.5", chain: "BEP20" }) });
    const w1rb = (await w1r.json()) as { withdrawal: { id: string } };
    const rows = await prisma.withdrawal.count({ where: { keyId: A.id } });
    check(w1r.status === 202 && w1rb.withdrawal.id === w1b.withdrawal.id && w1r.headers.get("idempotent-replayed") === "true" && rows === 1, "5b. replay returns the same withdrawal, Idempotent-Replayed, still ONE row", `rows=${rows}`);
    // 5c. same key, different body → 409 mismatch
    const w1m = await app.request("/withdrawals", { method: "POST", headers: hdr(A.plaintext, `wd-${RUN}`), body: JSON.stringify({ to: "0x" + "d".repeat(40), amount: "1", chain: "BEP20" }) });
    check(w1m.status === 409, "5c. same Idempotency-Key with a different body → 409", `status=${w1m.status}`);

    // 6. over the remaining allowance → 409 with the three numbers, unclamped, no row
    const w2 = await app.request("/withdrawals", { method: "POST", headers: hdr(A.plaintext, `wd2-${RUN}`), body: JSON.stringify({ to: "0x" + "e".repeat(40), amount: "3.500001", chain: "BEP20" }) });
    const w2b = (await w2.json()) as { error: { code: string; details: { received: string; withdrawn: string; requested: string } } };
    const rows2 = await prisma.withdrawal.count({ where: { keyId: A.id } });
    check(w2.status === 409 && w2b.error.code === "allowance_exceeded" && w2b.error.details.received === "10" && w2b.error.details.withdrawn === "6.5" && w2b.error.details.requested === "3.500001" && rows2 === 1, "6. over-allowance refused 409 allowance_exceeded with received/withdrawn/requested; no row written", JSON.stringify(w2b.error?.details));

    // 7. isolation: key B sees none of it
    const balB = (await (await app.request("/balance", { headers: hdr(B.plaintext) })).json()) as { balance: { received: string; deposit_count: number } };
    const depB = (await (await app.request("/deposits", { headers: hdr(B.plaintext) })).json()) as { deposits: unknown[] };
    const wdB = await app.request(`/withdrawals/${w1b.withdrawal.id}`, { headers: hdr(B.plaintext) });
    check(balB.balance.received === "0" && balB.balance.deposit_count === 0 && depB.deposits.length === 0 && wdB.status === 404, "7. ISOLATION — key B: balance 0, no deposits, A's withdrawal is 404", `${wdB.status}`);

    // 8. the sender stub is refused (rejected) and the row is `failed` — still CONSUMING (allowance unchanged)
    await new Promise((r) => setTimeout(r, 300));
    const w1s = await prisma.withdrawal.findUniqueOrThrow({ where: { id: w1b.withdrawal.id }, select: { status: true } });
    const bal2 = (await (await app.request("/balance", { headers: hdr(A.plaintext) })).json()) as { balance: { allowance: string } };
    check(w1s.status === "failed" && bal2.balance.allowance === "3.5", "8. a failed (pre-broadcast) send keeps CONSUMING: status=failed, allowance still 3.5 (restore needs evidence)", `status=${w1s.status} allowance=${bal2.balance.allowance}`);
    // 8c. finding 1: with NO chain (ChainUnavailable) a request is RELEASED with a reason, not left pending
    setChainAdapters({ sender: { async send() { throw new (await import("@/chain/registry.js")).ChainUnavailable("send"); } } });
    const w3 = await app.request("/withdrawals", { method: "POST", headers: hdr(A.plaintext, `wd3-${RUN}`), body: JSON.stringify({ to: "0x" + "a".repeat(40), amount: "1", chain: "BEP20" }) });
    const w3b = (await w3.json()) as { withdrawal: { id: string } };
    await new Promise((r) => setTimeout(r, 300));
    const w3s = await prisma.withdrawal.findUniqueOrThrow({ where: { id: w3b.withdrawal.id }, select: { status: true, reservation: { select: { status: true, reason: true } } } });
    const cancelledHook = await prisma.webhookDelivery.count({ where: { keyId: A.id, eventType: "withdrawal.cancelled" } });
    const bal4 = (await (await app.request("/balance", { headers: hdr(A.plaintext) })).json()) as { balance: { allowance: string } };
    check(w3.status === 202 && w3s.status === "cancelled" && w3s.reservation?.reason === "chain_unavailable" && cancelledHook === 1 && bal4.balance.allowance === "3.5", "8c. ChainUnavailable → cancelled with reason chain_unavailable + webhook; allowance restored to 3.5, nothing left pending", `status=${w3s.status} reason=${w3s.reservation?.reason} hooks=${cancelledHook} allowance=${bal4.balance.allowance}`);
    const replayStatus = (await (await app.request("/withdrawals", { method: "POST", headers: hdr(A.plaintext, `wd3-${RUN}`), body: JSON.stringify({ to: "0x" + "a".repeat(40), amount: "1", chain: "BEP20" }) })).json()) as { withdrawal: { status: string; replayed: boolean } };
    check(replayStatus.withdrawal.replayed && replayStatus.withdrawal.status === "cancelled", "8d. a replay reports the REAL status (cancelled), not a stale pending", JSON.stringify(replayStatus.withdrawal));
    // 8b. CONTROL: the balance number is not clamped — force withdrawn > received in the DB and read
    await prisma.withdrawal.create({ data: { keyId: A.id, toAddress: "0x" + "f".repeat(40), chain: "BEP20", amount: new Prisma.Decimal("20"), status: "sent", idempotencyKey: `forced-${RUN}` } });
    const bal3 = (await (await app.request("/balance", { headers: hdr(A.plaintext) })).json()) as { balance: { allowance: string } };
    check(bal3.balance.allowance === "-16.5", "8b. CONTROL — /balance never clamps: a forced over-send reads -16.5", bal3.balance.allowance);
  } finally {
    await prisma.webhookDelivery.deleteMany({ where: { keyId: { in: made.keys } } }).catch(() => undefined);
    await prisma.reservation.deleteMany({ where: { keyId: { in: made.keys } } }).catch(() => undefined);
    await prisma.withdrawal.deleteMany({ where: { keyId: { in: made.keys } } }).catch(() => undefined);
    await prisma.idempotencyKey.deleteMany({ where: { keyId: { in: made.keys } } }).catch(() => undefined);
    await prisma.deposit.deleteMany({ where: { keyId: { in: made.keys } } }).catch(() => undefined);
    await prisma.address.deleteMany({ where: { keyId: { in: made.keys } } }).catch(() => undefined);
    await prisma.clientKey.deleteMany({ where: { id: { in: made.keys } } }).catch(() => undefined);
    await prisma.client.deleteMany({ where: { id: { in: made.clients } } }).catch(() => undefined);
    const left = (await prisma.deposit.count({ where: { keyId: { in: made.keys } } })) + (await prisma.withdrawal.count({ where: { keyId: { in: made.keys } } })) + (await prisma.address.count({ where: { keyId: { in: made.keys } } })) + (await prisma.clientKey.count({ where: { id: { in: made.keys } } })) + (await prisma.client.count({ where: { id: { in: made.clients } } }));
    console.log(`\n${pass} passed, ${fail} failed · ${left} left behind (counted; audit rows permanent by design)`);
    if (left !== 0) fail++;
    await prisma.$disconnect(); process.exit(fail === 0 ? 0 : 1);
  }
}
main().catch((e) => { console.error("verify-routes-end-to-end crashed:", e); process.exit(1); });
