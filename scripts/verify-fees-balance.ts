// COVERS: src/allowance/fee.ts src/allowance/read.ts src/allowance/read-by-chain.ts src/allowance/reserve.ts src/http/routes/balance.ts src/keys/terms.ts src/keys/provision.ts scripts/issue-key.ts scripts/ops/disable-address.ts prisma/schema.prisma
//
// PHASE 0 (G6) — RED-FIRST. Contract §0 (fee per merchant, from the GATEWAY
// balance), §2 (six default merchant scopes), §4 Balance (per chain,
// available / pending, fee_bps), §5 (min/max intent per client), §9 step 0
// (disable an address, never delete).
//
// Run on a throwaway cluster only:
//   G6_SCRATCH=<absolute scratch dir> bash /www/wwwroot/samaprime.com/scripts/throwaway-pg.sh \
//     ./node_modules/.bin/tsx scripts/throwaway-sandbox.ts scripts/verify-fees-balance.ts
// G6_SCRATCH is where the backup-gate fixtures are written (never the tree).
import crypto from "node:crypto";
process.env.SEED_ENCRYPTION_KEY ??= crypto.randomBytes(32).toString("base64");

import { writeFileSync, utimesSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Hono } from "hono";
import { Prisma } from "@prisma/client";
import { assertSandboxDatabase } from "@/db/guard.js";
import { prisma } from "@/db/client.js";
import { isScope } from "@/http/scopes.js";
import { ApiError } from "@/http/errors.js";
import { balance } from "@/http/routes/balance.js";
import { issueKey } from "@/keys/issue.js";
import { provisionClientKey } from "@/keys/provision.js";
import { MERCHANT_DEFAULT_SCOPES, termsFromArgv, TermsError } from "@/keys/terms.js";
import { computeFee, feeForConfirmation, read, readByChain, reserve, AllowanceExceeded, InvalidFeeBps } from "@/allowance/index.js";
import { backupProblem, disableAddress, parseArgs } from "./ops/disable-address.js";
import { check, summary, thrown, voidCheck } from "./lib/check.js";

const RUN = Date.now().toString(36);
let idx = 2_000_000 + (Date.now() % 100_000) * 10;
const nextIndex = () => idx++;

async function main() {
  console.log(`database: ${await assertSandboxDatabase()}`);

  // ── A. the one fee calculator ─────────────────────────────────────────
  check(computeFee("100", 250).toString() === "2.5", "A1. 100 USDT at 250 bps → fee 2.5", computeFee("100", 250).toString());
  check(computeFee("0.000009", 1).toString() === "0", "A2. truncated DOWN to 6 dp: 0.000009 at 1 bps → 0, never rounded up", computeFee("0.000009", 1).toString());
  check(computeFee("12.345678", 33).toString() === "0.04074", "A3. 12.345678 × 33 / 10000 = 0.0407407374 → 0.04074 (down)", computeFee("12.345678", 33).toString());
  check(computeFee("7", 10000).toString() === "7" && computeFee("7", 0).toString() === "0", "A4. bounds: 10000 bps = the whole amount, 0 bps = 0");
  const badBps = await thrown(async () => computeFee("1", 10001));
  const fracBps = await thrown(async () => computeFee("1", 2.5));
  check(badBps.name === "InvalidFeeBps" && fracBps.name === "InvalidFeeBps", "A5. fee_bps outside 0..10000 or fractional is refused (InvalidFeeBps)", `${badBps.name}/${fracBps.name}`);
  void InvalidFeeBps;

  // ── B. terms + default scopes (the CLI's definitions) ──────────────────
  const six = ["payment_intents.write", "payment_intents.read", "deposits.read", "addresses.write", "balance.read", "events.read"];
  check(MERCHANT_DEFAULT_SCOPES.length === 6 && six.every((s) => (MERCHANT_DEFAULT_SCOPES as readonly string[]).includes(s)) && !(MERCHANT_DEFAULT_SCOPES as readonly string[]).includes("keys.issue"), "B1. the merchant default is exactly the contract's six scopes, never keys.issue", MERCHANT_DEFAULT_SCOPES.join(","));
  const unknown = six.filter((s) => !isScope(s));
  if (unknown.length) voidCheck("B2. every default scope is issuable", `not in src/http/scopes.ts yet: ${unknown.join(",")} (G1 owns that file)`);
  else check(true, "B2. every default scope is issuable (isScope)");
  const argv = termsFromArgv(["x", "--fee-bps", "250", "--min-intent", "5", "--max-intent", "500.5", "--chains", "TRC20"]);
  check(JSON.stringify(argv) === JSON.stringify({ feeBps: 250, minIntent: "5", maxIntent: "500.5", enabledChains: ["TRC20"] }), "B3. the CLI flags parse into terms", JSON.stringify(argv));
  check(JSON.stringify(termsFromArgv(["x", "--name", "k"])) === "{}", "B4. no terms flags → no change requested");

  const made: string[] = [];
  const name = `verify-g6-${RUN}`;
  try {
    // B5. provisioning with terms sets them on the new client + one audit row
    const p = await provisionClientKey({ clientName: name, kind: "merchant", keyName: "gw", scopes: ["balance.read", "withdrawals.write"], issuedBy: "verify", environment: "test", terms: { feeBps: 250, minIntent: "5", maxIntent: "500" } });
    made.push(p.client.id);
    const row = await prisma.client.findUniqueOrThrow({ where: { id: p.client.id }, select: { feeBps: true, minIntent: true, maxIntent: true, enabledChains: true } });
    const auditTerms = await prisma.auditEvent.count({ where: { action: "client.terms_set", subjectId: p.client.id } });
    check(row.feeBps === 250 && row.minIntent.toString() === "5" && row.maxIntent.toString() === "500" && row.enabledChains.join() === "BEP20,TRC20" && auditTerms === 1, "B5. --fee-bps/--min-intent/--max-intent land on the client; chains keep the default; one client.terms_set audit row", `${JSON.stringify(row)} audit=${auditTerms}`);

    // B6. a bad fee refuses BEFORE any row: no client is created
    const badName = `${name}-bad`;
    const bad = await thrown(() => provisionClientKey({ clientName: badName, kind: "merchant", keyName: "gw", scopes: ["balance.read"], issuedBy: "verify", terms: { feeBps: 10001 } }));
    const badClients = await prisma.client.count({ where: { name: badName } });
    check(bad.name === "TermsError" && badClients === 0, "B6. fee_bps 10001 → TermsError, no client written", `${bad.name} clients=${badClients}`);
    // B7. min above max (against the client's CURRENT max) is refused; nothing changes
    const { applyTerms } = await import("@/keys/provision.js");
    const minMax = await thrown(() => applyTerms(p.client.id, { minIntent: "600" }, "verify"));
    const after7 = await prisma.client.findUniqueOrThrow({ where: { id: p.client.id }, select: { minIntent: true } });
    check(minMax.err instanceof TermsError && (minMax.err as TermsError).code === "min_above_max" && after7.minIntent.toString() === "5", "B7. min_intent 600 over the client's max 500 → refused, unchanged", `${minMax.name} min=${after7.minIntent}`);
    const sevenDp = await thrown(() => applyTerms(p.client.id, { maxIntent: "1.0000001" }, "verify"));
    check(sevenDp.name === "TermsError", "B8. an amount with 7 decimals is refused", sevenDp.name);

    // ── C. balance: per chain, fees stamped, pending gross ──────────────
    const keyId = p.key.id;
    const addr = async (chain: "TRC20" | "BEP20") => (await prisma.address.create({ data: { keyId, chain, reference: `verify:g6:user:${RUN}`, address: `G6${chain}${RUN}${nextIndex()}`, derivationIndex: nextIndex() }, select: { id: true } })).id;
    const tA = await addr("TRC20"); const bA = await addr("BEP20");
    const dep = (chain: "TRC20" | "BEP20", addressId: string, amount: string, status: "confirmed" | "detected", fee: Prisma.Decimal | string = "0") =>
      prisma.deposit.create({ data: { keyId, addressId, chain, txHash: `g6-${RUN}-${nextIndex()}`, amount: new Prisma.Decimal(amount), status, feeAmount: new Prisma.Decimal(fee), ...(status === "confirmed" ? { creditedAt: new Date() } : {}) } });
    // the fee is what feeForConfirmation says for THIS key — the observer's call
    const fee100 = await prisma.$transaction((tx) => feeForConfirmation(tx, keyId, "100"));
    check(fee100.toString() === "2.5", "C1. feeForConfirmation reads the key's client fee_bps (250) → 2.5 on 100", fee100.toString());
    await dep("TRC20", tA, "100", "confirmed", fee100);
    await dep("TRC20", tA, "7", "detected");
    await dep("BEP20", bA, "10", "confirmed", "0");
    await prisma.withdrawal.create({ data: { keyId, toAddress: "0xdest", chain: "BEP20", amount: new Prisma.Decimal("3"), status: "pending", idempotencyKey: `g6-w1-${RUN}` } });
    await prisma.withdrawal.create({ data: { keyId, toAddress: "0xdest", chain: "BEP20", amount: new Prisma.Decimal("50"), status: "cancelled", idempotencyKey: `g6-w2-${RUN}` } });

    const app = new Hono();
    app.route("/balance", balance);
    app.onError((err, c) => (err instanceof ApiError ? c.json(err.toBody(), err.status as 400) : c.json({ error: String(err) }, 500)));
    // the key needs a plaintext: issue one on the same client for the HTTP read
    const reader = await issueKey({ clientId: p.client.id, name: "reader", scopes: ["balance.read"], environment: "test", issuedBy: "verify", issuedVia: "cli" });
    // same client, different key: its OWN position is zero (per key)
    const res = await app.request("/balance", { headers: { authorization: `Bearer ${reader.plaintext}` } });
    const rb = (await res.json()) as Record<string, unknown>;
    const want0 = { object: "balance", currency: "USDT", chains: { TRC20: { available: "0", pending: "0" }, BEP20: { available: "0", pending: "0" } }, fee_bps: 250 };
    check(res.status === 200 && JSON.stringify(rb) === JSON.stringify(want0), "C2. GET /balance renders the contract object; per KEY (a sibling key sees 0)", JSON.stringify(rb));

    // the funded key, read through the same function the route renders
    const { balanceBody } = await import("@/http/routes/balance.js");
    const body = await balanceBody(keyId, p.client.id);
    const want = { object: "balance", currency: "USDT", chains: { TRC20: { available: "97.5", pending: "7" }, BEP20: { available: "7", pending: "0" } }, fee_bps: 250 };
    check(JSON.stringify(body) === JSON.stringify(want), "C3. available = confirmed − stamped fee − consuming withdrawals; pending = detected, gross; cancelled not counted", JSON.stringify(body));
    const pos = await read(keyId);
    const byChain = await readByChain(keyId);
    const sum = byChain.TRC20.available.plus(byChain.BEP20.available);
    check(pos.fees.toString() === "2.5" && pos.allowance.toString() === "104.5" && sum.equals(pos.allowance), "C4. the withdrawal bound read() = Σ per-chain available (104.5): display and charge are one number", `fees=${pos.fees} allowance=${pos.allowance} Σavailable=${sum}`);

    // C5. changing fee_bps later never rewrites a stamped fee
    await applyTerms(p.client.id, { feeBps: 5000 }, "verify");
    const body5 = await balanceBody(keyId, p.client.id);
    check(body5.chains.TRC20?.available === "97.5" && body5.fee_bps === 5000, "C5. fee_bps 250 → 5000 afterwards: the TRC20 available stays 97.5; fee_bps shows the new rate", JSON.stringify(body5));

    // C6. reserve honours the fee: 104.500001 refused, 104.5 accepted
    const over = await thrown(() => prisma.$transaction((tx) => reserve(tx, { keyId, amount: "104.500001", idempotencyKey: `g6-r1-${RUN}`, toAddress: "0xdest", chain: "BEP20" })));
    check(over.err instanceof AllowanceExceeded && (over.err as AllowanceExceeded).fees === "2.5", "C6. a withdrawal 0.000001 above received − fees − withdrawn is refused, the fee named", `${over.name} ${(over.err as Error | undefined)?.message ?? ""}`);
    const exact = await thrown(() => prisma.$transaction((tx) => reserve(tx, { keyId, amount: "104.5", idempotencyKey: `g6-r2-${RUN}`, toAddress: "0xdest", chain: "BEP20" })));
    check(exact.name === "NO THROW", "C7. exactly received − fees − withdrawn (104.5) is allowed", exact.name);

    // ── D. disable-address (§9 step 0) ──────────────────────────────────
    const target = await prisma.address.create({ data: { keyId, chain: "TRC20", reference: `verify:g6:legacy:${RUN}`, address: `TG6disable${RUN}`, derivationIndex: nextIndex(), legacyImport: true }, select: { id: true, address: true } });
    const addrCount0 = await prisma.address.count();
    const dry = await disableAddress(prisma, { address: target.address, apply: false });
    const afterDry = await prisma.address.findUniqueOrThrow({ where: { id: target.id }, select: { watchDisabledAt: true } });
    check(dry.outcome === "would_disable" && afterDry.watchDisabledAt === null, "D1. dry run (the default) reports would_disable and writes nothing", dry.outcome);
    check(parseArgs(["--address=" + target.address]).apply === false, "D2. no --apply flag → dry run");
    const noBackup = await thrown(async () => parseArgs(["--address=" + target.address, "--apply"]));
    check(noBackup.name === "Error" && /--backup/.test(String((noBackup.err as Error)?.message)), "D3. --apply without --backup/--by is refused at parse time", String((noBackup.err as Error | undefined)?.message));
    const auditBefore = await prisma.auditEvent.count({ where: { action: "address.watch_disabled", subjectId: target.id } });
    const applied = await disableAddress(prisma, { address: target.address, apply: true, by: "verify", reason: "old seed" });
    const stamped = await prisma.address.findUniqueOrThrow({ where: { id: target.id }, select: { watchDisabledAt: true } });
    const auditAfter = await prisma.auditEvent.count({ where: { action: "address.watch_disabled", subjectId: target.id } });
    check(applied.outcome === "disabled" && stamped.watchDisabledAt !== null && auditAfter - auditBefore === 1, "D4. --apply sets watch_disabled_at + one audit row", `${applied.outcome} at=${stamped.watchDisabledAt?.toISOString()} audit +${auditAfter - auditBefore}`);
    const again = await disableAddress(prisma, { address: target.address, apply: true, by: "verify" });
    const kept = await prisma.address.findUniqueOrThrow({ where: { id: target.id }, select: { watchDisabledAt: true } });
    const auditAgain = await prisma.auditEvent.count({ where: { action: "address.watch_disabled", subjectId: target.id } });
    check(again.outcome === "already_disabled" && kept.watchDisabledAt?.getTime() === stamped.watchDisabledAt?.getTime() && auditAgain === auditAfter, "D5. a second --apply is a no-op: original timestamp kept, no second audit row", again.outcome);
    const addrCount1 = await prisma.address.count();
    check(addrCount1 === addrCount0, "D6. never deletes: address row count unchanged", `${addrCount0}→${addrCount1}`);
    const ghost = await disableAddress(prisma, { address: `Tnosuch${RUN}xxxxxxxxxxxx`, apply: true, by: "verify" });
    check(ghost.outcome === "not_found", "D7. an unknown address → not_found, nothing written", ghost.outcome);

    // D8. backup gate
    const dir = process.env.G6_SCRATCH;
    if (!dir || !isAbsolute(dir)) voidCheck("D8. backup gate", "G6_SCRATCH (absolute scratch dir) not set — fixtures are never written into the tree");
    else {
      const f = join(dir, `backup-${RUN}.dump`);
      writeFileSync(f, "not really a dump");
      const fresh = await backupProblem(prisma, f);
      const past = new Date(Date.now() - 60 * 60 * 1000);
      utimesSync(f, past, past); // an hour ago: BEFORE D4's hand-run write
      const stale = await backupProblem(prisma, f);
      const missing = await backupProblem(prisma, join(dir, `absent-${RUN}`));
      const relative = await backupProblem(prisma, "backup.dump");
      check(fresh === null && /predates the last hand-run write/.test(stale ?? "") && /does not exist/.test(missing ?? "") && /not absolute/.test(relative ?? ""), "D8. backup gate: fresh passes; older than the last ops/cli write, missing, or relative is refused", JSON.stringify({ fresh, stale, missing, relative }));
    }
  } finally {
    // Fixtures stay on the disposable cluster; it is discarded with the run.
    console.log(`fixture clients: ${made.join(",")}`);
  }
  await prisma.$disconnect();
  process.exit(summary());
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
