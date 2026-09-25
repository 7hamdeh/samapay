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

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
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
import { MERCHANT_DEFAULT_SCOPES, normalizeArgv, termsFromArgv, TermsError } from "@/keys/terms.js";
import { computeFee, feeForConfirmation, read, readClientByChain, reserve, AllowanceExceeded, InvalidFeeBps } from "@/allowance/index.js";
import { disableAddress, disableValues } from "./ops/disable-address.js";
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
  const runbook = normalizeArgv(["x", "--client=SamaPrime", "--kind=merchant", "--fee-bps=0", "--webhook-url=http://127.0.0.1:3033/api/webhooks/samapay/c1?a=b"]);
  check(JSON.stringify(runbook) === JSON.stringify(["x", "--client", "SamaPrime", "--kind", "merchant", "--fee-bps", "0", "--webhook-url", "http://127.0.0.1:3033/api/webhooks/samapay/c1?a=b"]) && JSON.stringify(termsFromArgv(runbook)) === JSON.stringify({ feeBps: 0 }), "B9. the runbook's --flag=value form parses the same as --flag value (value may contain '=')", JSON.stringify(runbook));

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
    const addr = async (chain: "TRC20" | "BEP20") => (await prisma.address.create({ data: { keyId, clientId: p.client.id, chain, reference: `verify:g6:user:${RUN}`, address: `G6${chain}${RUN}${nextIndex()}`, derivationIndex: nextIndex() }, select: { id: true } })).id;
    const tA = await addr("TRC20"); const bA = await addr("BEP20");
    const dep = (chain: "TRC20" | "BEP20", addressId: string, amount: string, status: "confirmed" | "detected", fee: Prisma.Decimal | string = "0") =>
      prisma.deposit.create({ data: { keyId, clientId: p.client.id, addressId, chain, txHash: `g6-${RUN}-${nextIndex()}`, amount: new Prisma.Decimal(amount), status, feeAmount: new Prisma.Decimal(fee), ...(status === "confirmed" ? { creditedAt: new Date() } : {}) } });
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
    // the funded key, read over HTTP (its plaintext came back once from provisioning)
    const getBalance = async (plaintext = p.key.plaintext) => (await (await app.request("/balance", { headers: { authorization: `Bearer ${plaintext}` } })).json()) as { chains?: Record<string, { available: string }>; fee_bps?: number };
    const body = await getBalance();
    const want = { object: "balance", currency: "USDT", chains: { TRC20: { available: "97.5", pending: "7" }, BEP20: { available: "7", pending: "0" } }, fee_bps: 250 };
    check(JSON.stringify(body) === JSON.stringify(want), "C3. GET /balance is the contract object: available = confirmed − stamped fee − consuming withdrawals; pending = detected, gross; cancelled not counted", JSON.stringify(body));
    // C2. per CLIENT (A6): a rotated-in key of the SAME client sees the same balance; another client sees 0
    const sibling = await issueKey({ clientId: p.client.id, name: "rotated-in", scopes: ["balance.read"], environment: "test", issuedBy: "verify", issuedVia: "cli" });
    const other = await provisionClientKey({ clientName: `${name}-other`, kind: "merchant", keyName: "gw", scopes: ["balance.read"], issuedBy: "verify", environment: "test" });
    made.push(other.client.id);
    const sib = await getBalance(sibling.plaintext);
    const oth = await getBalance(other.key.plaintext);
    const want0 = { object: "balance", currency: "USDT", chains: { TRC20: { available: "0", pending: "0" }, BEP20: { available: "0", pending: "0" } }, fee_bps: 0 };
    check(JSON.stringify(sib) === JSON.stringify(want) && JSON.stringify(oth) === JSON.stringify(want0), "C2. balance is per CLIENT: a second key of the same client sees the same numbers; another client sees 0", `sibling=${JSON.stringify(sib.chains)} other=${JSON.stringify(oth.chains)}`);
    const pos = await read(keyId);
    const byChain = await readClientByChain(p.client.id);
    const sum = byChain.TRC20.available.plus(byChain.BEP20.available);
    check(pos.fees?.toString() === "2.5" && pos.allowance.toString() === "104.5" && sum.equals(pos.allowance), "C4. the per-key withdrawal bound read() = Σ per-chain client available (104.5; the only funded key): same rows, one number", `fees=${pos.fees} allowance=${pos.allowance} Σavailable=${sum}`);

    // C5. changing fee_bps later never rewrites a stamped fee
    await applyTerms(p.client.id, { feeBps: 5000 }, "verify");
    const body5 = await getBalance();
    check(body5.chains?.TRC20?.available === "97.5" && body5.fee_bps === 5000, "C5. fee_bps 250 → 5000 afterwards: the TRC20 available stays 97.5; fee_bps shows the new rate", JSON.stringify(body5));

    // F. WATCH-DISABLED ADDRESSES DO NOT COUNT (review Q M4 — the written-off
    //    3.01 USDT sits under the SamaPrime client in production).
    const woAddr = await prisma.address.create({ data: { keyId, clientId: p.client.id, chain: "TRC20", reference: `verify:g6:writeoff:${RUN}`, address: `TG6wo${RUN}${"z".repeat(20)}`, derivationIndex: nextIndex() }, select: { id: true, address: true } });
    await dep("TRC20", woAddr.id, "3.01", "confirmed", "0");
    await dep("TRC20", woAddr.id, "1", "detected");
    const beforeWo = await getBalance();
    const allowBefore = (await read(keyId)).allowance.toString();
    check(beforeWo.chains?.TRC20?.available === "100.51" && allowBefore === "107.51", "F1. CONTROL: while the address is watched, its 3.01 counts (TRC20 available 100.51, allowance 107.51)", `${JSON.stringify(beforeWo.chains?.TRC20)} allowance=${allowBefore}`);
    await disableAddress(prisma, { address: woAddr.address, apply: true, by: "verify", reason: "write-off" });
    const afterWo = (await getBalance()) as { chains?: Record<string, { available: string; pending: string }> };
    const allowAfter = (await read(keyId)).allowance.toString();
    check(afterWo.chains?.TRC20?.available === "97.5" && afterWo.chains?.TRC20?.pending === "7" && allowAfter === "104.5", "F2. once watch-disabled, its deposits leave available AND pending AND the withdrawal bound (97.5 / 7 / 104.5)", `${JSON.stringify(afterWo.chains?.TRC20)} allowance=${allowAfter}`);

    // C6. reserve honours the fee: 104.500001 refused, 104.5 accepted
    const over = await thrown(() => prisma.$transaction((tx) => reserve(tx, { keyId, amount: "104.500001", idempotencyKey: `g6-r1-${RUN}`, toAddress: "0xdest", chain: "BEP20" })));
    check(over.err instanceof AllowanceExceeded && (over.err as AllowanceExceeded).fees === "2.5", "C6. a withdrawal 0.000001 above received − fees − withdrawn is refused, the fee named", `${over.name} ${(over.err as Error | undefined)?.message ?? ""}`);
    const exact = await thrown(() => prisma.$transaction((tx) => reserve(tx, { keyId, amount: "104.5", idempotencyKey: `g6-r2-${RUN}`, toAddress: "0xdest", chain: "BEP20" })));
    check(exact.name === "NO THROW", "C7. exactly received − fees − withdrawn (104.5) is allowed", exact.name);

    // ── D. disable-address (§9 step 0) ──────────────────────────────────
    const target = await prisma.address.create({ data: { keyId, clientId: p.client.id, chain: "TRC20", reference: `verify:g6:legacy:${RUN}`, address: `TG6disable${RUN}${"x".repeat(20)}`, derivationIndex: nextIndex(), legacyImport: true }, select: { id: true, address: true } });
    const addrCount0 = await prisma.address.count();
    const dry = await disableAddress(prisma, { address: target.address, apply: false });
    const afterDry = await prisma.address.findUniqueOrThrow({ where: { id: target.id }, select: { watchDisabledAt: true } });
    check(dry.outcome === "would_disable" && afterDry.watchDisabledAt === null, "D1. dry run (the default) reports would_disable and writes nothing", dry.outcome);
    const dv = disableValues(new Map([["--address", target.address]]));
    const badAddr = await thrown(async () => disableValues(new Map([["--address", "x y"]])));
    check(dv.by === "ibrahim" && dv.address === target.address && badAddr.name === "Error", "D2. values: --by defaults to ibrahim; a malformed --address is refused", JSON.stringify(dv));
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

    // D8. THE CLI, through G4's ops gate (review Q M3): where-am-I + fresh-backup, spawned for real.
    const dir = process.env.G6_SCRATCH;
    if (!dir || !isAbsolute(dir)) voidCheck("D8. disable-address CLI gate", "G6_SCRATCH (absolute scratch dir) not set — backup fixtures are never written into the tree");
    else {
      const cliTarget = await prisma.address.create({ data: { keyId, clientId: p.client.id, chain: "TRC20", reference: `verify:g6:cli:${RUN}`, address: `TG6cli${RUN}${"y".repeat(20)}`, derivationIndex: nextIndex() }, select: { id: true, address: true } });
      const bkDir = join(dir, `bk-${RUN}`);
      mkdirSync(bkDir, { recursive: true });
      const cli = (...args: string[]) => {
        const r = spawnSync("./node_modules/.bin/tsx", ["scripts/ops/disable-address.ts", ...args], { env: { ...process.env, SAMAPAY_OPS_REHEARSAL_BACKUP_DIR: bkDir }, encoding: "utf8" });
        return { code: r.status, out: `${r.stdout}${r.stderr}` };
      };
      const stampOf = async () => (await prisma.address.findUniqueOrThrow({ where: { id: cliTarget.id }, select: { watchDisabledAt: true } })).watchDisabledAt;
      const notProd = cli(`--address=${cliTarget.address}`);
      check(notProd.code === 1 && /REFUSED: expected production database samapay/.test(notProd.out), "D8a. without --rehearsal the CLI refuses any database but production (where-am-I)", `exit=${notProd.code}`);
      const noBk = cli(`--address=${cliTarget.address}`, "--rehearsal", "--apply");
      check(noBk.code === 1 && /REFUSED: --apply needs --backup/.test(noBk.out) && (await stampOf()) === null, "D8b. --apply without --backup is REFUSED (exit 1), nothing written", `exit=${noBk.code}`);
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace(/^(\d{4})(\d{2})(\d{2})T/, "$1-$2-$3T");
      const junk = join(bkDir, `backup-${RUN}.dump`);
      writeFileSync(junk, "x".repeat(20_000));
      const wrongName = cli(`--address=${cliTarget.address}`, "--rehearsal", "--apply", `--backup=${junk}`);
      check(wrongName.code === 1 && /is not named samapay-/.test(wrongName.out) && (await stampOf()) === null, "D8c. a backup not named like samapay-backup.sh's dump is REFUSED, nothing written", `exit=${wrongName.code}`);
      const good = join(bkDir, `samapay-${stamp}.dump.gpg`);
      writeFileSync(good, crypto.randomBytes(20_000));
      const noSide = cli(`--address=${cliTarget.address}`, "--rehearsal", "--apply", `--backup=${good}`);
      check(noSide.code === 1 && /no \.sha256 sidecar/.test(noSide.out) && (await stampOf()) === null, "D8d. a dump without its .sha256 sidecar is REFUSED, nothing written", `exit=${noSide.code}`);
      writeFileSync(`${good}.sha256`, `${createHash("sha256").update(readFileSync(good)).digest("hex")}\n`);
      writeFileSync(`${good}.content`, `content-check stamp=${stamp} tables=12/12 sha256=${createHash("sha256").update(readFileSync(good)).digest("hex")}\n`);
      const dryCli = cli(`--address=${cliTarget.address}`, "--rehearsal");
      check(dryCli.code === 0 && /would_disable/.test(dryCli.out) && (await stampOf()) === null, "D8e. --rehearsal dry run: exit 0, would_disable, nothing written", `exit=${dryCli.code}`);
      const ok = cli(`--address=${cliTarget.address}`, "--rehearsal", "--apply", `--backup=${good}`);
      const stamped8 = await stampOf();
      check(ok.code === 0 && /"outcome": "disabled"/.test(ok.out) && stamped8 !== null, "D8f. --apply with a fresh named dump + matching sidecar: exit 0, watch_disabled_at set", `exit=${ok.code} at=${stamped8?.toISOString()}`);
    }

    // ── E. schema: A7 / G3 uniqueness + the migration's backfill SQL ─────
    const p2002 = (r: { err?: unknown }) => r.err instanceof Prisma.PrismaClientKnownRequestError && r.err.code === "P2002";
    const ref = `verify:g6:dup:${RUN}`;
    await prisma.address.create({ data: { keyId, clientId: p.client.id, chain: "BEP20", reference: ref, address: `0xG6dupA${RUN}`, derivationIndex: nextIndex() } });
    const dupAddr = await thrown(() => prisma.address.create({ data: { keyId: sibling.id, clientId: p.client.id, chain: "BEP20", reference: ref, address: `0xG6dupB${RUN}`, derivationIndex: nextIndex() } }));
    const otherChain = await thrown(() => prisma.address.create({ data: { keyId, clientId: p.client.id, chain: "TRC20", reference: ref, address: `TG6dupC${RUN}`, derivationIndex: nextIndex() } }));
    check(p2002(dupAddr) && otherChain.name === "NO THROW", "E1. UNIQUE(client_id, chain, reference) on addresses: same client+chain+reference refused (even from another key); other chain allowed", `${dupAddr.name}/${otherChain.name}`);
    const piAddr = async () => (await prisma.address.create({ data: { keyId, clientId: p.client.id, chain: "TRC20", reference: `verify:g6:pi:${RUN}:${nextIndex()}`, address: `TG6pi${RUN}${nextIndex()}`, derivationIndex: nextIndex() }, select: { id: true } })).id;
    const pi = (id: string, addressId: string) => prisma.paymentIntent.create({ data: { id, clientId: p.client.id, keyId, addressId, chain: "TRC20", amount: new Prisma.Decimal("5"), reference: `store:${RUN}`, expiresAt: new Date(Date.now() + 3_600_000) } });
    await pi(`pi_g6a${RUN}`, await piAddr());
    const dupPi = await thrown(async () => pi(`pi_g6b${RUN}`, await piAddr()));
    check(p2002(dupPi), "E2. UNIQUE(client_id, reference) on payment_intents: a second intent with the same reference is refused", dupPi.name);
    const dl = () => prisma.webhookDelivery.create({ data: { keyId, clientId: p.client.id, eventType: "deposit.confirmed", eventId: `evt_g6${RUN}`, payload: {} } });
    await dl();
    const dupDl = await thrown(dl);
    check(p2002(dupDl), "E3. UNIQUE(key_id, event_id) on webhook_deliveries: a second delivery series for one event+key is refused", dupDl.name);
    const ev = (id: string) => prisma.event.create({ data: { id, clientId: p.client.id, keyId, type: "payment_intent.succeeded", objectKind: "payment_intent", objectId: `pi_g6a${RUN}`, snapshot: { id: `pi_g6a${RUN}` } } });
    await ev(`evt_g6a${RUN}`);
    const dupEv = await thrown(() => ev(`evt_g6b${RUN}`));
    check(p2002(dupEv), "E4. UNIQUE(object_id, type) on events: a second payment_intent.succeeded for one intent is refused", dupEv.name);

    // E5. the migration's OWN backfill statements (read from the file, not retyped) fill client_id from the key
    const sql = readFileSync(new URL("../prisma/migrations/20260925000000_phase0/migration.sql", import.meta.url), "utf8");
    const updates = sql.split("\n").filter((l) => l.startsWith("UPDATE \""));
    const nullAddr = await prisma.address.create({ data: { keyId, chain: "BEP20", reference: `verify:g6:null:${RUN}`, address: `0xG6null${RUN}`, derivationIndex: nextIndex() }, select: { id: true } });
    // CONFIRMED, not detected: a detected BEP20 row left on the shared throwaway
    // DB would be promoted by the next script's observer tick (measured: it broke
    // verify-routes-end-to-end check 4 when run after this script).
    const nullDep = await prisma.deposit.create({ data: { keyId, addressId: nullAddr.id, chain: "BEP20", txHash: `g6-null-${RUN}`, amount: new Prisma.Decimal("1"), status: "confirmed", creditedAt: new Date() }, select: { id: true } });
    const nullDl = await prisma.webhookDelivery.create({ data: { keyId, eventType: "deposit.confirmed", eventId: `evt_g6null${RUN}`, payload: {} }, select: { id: true } });
    for (const u of updates) await prisma.$executeRawUnsafe(u);
    const [fa, fd, fw] = await Promise.all([
      prisma.address.findUniqueOrThrow({ where: { id: nullAddr.id }, select: { clientId: true } }),
      prisma.deposit.findUniqueOrThrow({ where: { id: nullDep.id }, select: { clientId: true } }),
      prisma.webhookDelivery.findUniqueOrThrow({ where: { id: nullDl.id }, select: { clientId: true } }),
    ]);
    check(updates.length === 3 && fa.clientId === p.client.id && fd.clientId === p.client.id && fw.clientId === p.client.id, "E5. the migration file's 3 backfill UPDATEs set client_id from client_keys on addresses, deposits, webhook_deliveries", `updates=${updates.length} ${fa.clientId}/${fd.clientId}/${fw.clientId}`);
  } finally {
    // Fixtures stay on the disposable cluster; it is discarded with the run.
    console.log(`fixture clients: ${made.join(",")}`);
  }
  await prisma.$disconnect();
  process.exit(summary());
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
