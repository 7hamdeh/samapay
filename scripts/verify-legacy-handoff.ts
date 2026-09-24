// COVERS: scripts/import-legacy-addresses.ts scripts/ops/start-legacy-watch.ts src/chain/cursor.ts
//
// Contract §9 steps 4 and 5b — the legacy import and the cursor handoff, run
// as the REAL CLIs (spawned), against a throwaway database only:
//
//   bash /www/wwwroot/samaprime.com/scripts/throwaway-pg.sh \
//     ./node_modules/.bin/tsx scripts/throwaway-sandbox.ts scripts/verify-legacy-handoff.ts
//
// Throwaway material only: SEED_ENCRYPTION_KEY and a BIP39 mnemonic are
// GENERATED in this process; the "MNTAD export" is addresses derived from that
// generated seed. No real seed, key, address or RPC.
//
// Import:  1 re-derivation mismatch refused, 0 rows written
//          2 unmapped merchant / non-merchant key refused
//          3 dry run writes nothing
//          4 apply writes every row exactly (key, reference, legacy_import)
//          5 a second run writes 0 (idempotent)
//          6 an existing row that differs is refused, never overwritten
// Handoff (contract v1.1 A2: cursor = MIN(SamaPay cursor, MNTAD final − depth)):
//          H0 the MIN rule as a pure function
//          7 a cursor file missing a chain (or with an extra key) is refused
//          8 a target below a legacy deposit SamaPay already recorded (rewinding
//            past existing legacy history) is refused on BOTH chains
//          8b not mainnet → refused unless --rehearsal
//          9 dry run writes nothing; prints network + TRC20/BEP20 depth
//         10 apply: a cursor AHEAD moves back to the MIN, one BEHIND stays;
//            legacy_watch_enabled_at stamped on both, one transaction
//         11 re-run from the saved file: no change (also after the observer moved)
//         12 importing NEW legacy rows after the handoff is refused
//         13 the import leaves watch_disabled_at NULL
import crypto from "node:crypto";
process.env.SEED_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.SAMAPAY_DERIVATION_FLOOR_TRC20 = "1000";
process.env.SAMAPAY_DERIVATION_FLOOR_BEP20 = "1000";
// Mainnet CONFIG (depths 19 / 15, the production numbers) — read, never dialled:
// nothing here or in the two CLIs opens an RPC connection.
process.env.CRYPTO_MODE = "mainnet";

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as bip39 from "bip39";
import type { Chain } from "@prisma/client";
import { assertSandboxDatabase } from "@/db/guard.js";
import { prisma } from "@/db/client.js";
import { saveMasterSeedConfig } from "@/chain/seed/master-seed.js";
import { deriveAddress } from "@/chain/hd/derive.js";
import { getChainConfig } from "@/chain/impl/config.js";
import { check, summary } from "./lib/check.js";

const RUN = Date.now().toString(36);
// Input files under $VERIFY_TMP (a scratch folder), else the OS temp dir. Not
// TMPDIR: tsx puts its IPC socket there and a long path overflows sun_path.
const DIR = mkdtempSync(join(process.env.VERIFY_TMP ?? tmpdir(), "verify-legacy-handoff-"));
const IMPORT = "scripts/import-legacy-addresses.ts";
const WATCH = "scripts/ops/start-legacy-watch.ts";

function run(script: string, args: string[], env: Record<string, string> = {}): { code: number | null; out: string } {
  const r = spawnSync("./node_modules/.bin/tsx", [script, ...args], { env: { ...process.env, LOG_LEVEL: "silent", ...env }, encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  console.log(out.split("\n").filter(Boolean).map((l) => `      | ${l}`).join("\n"));
  return { code: r.status, out };
}
function file(name: string, content: unknown): string {
  const p = join(DIR, name);
  writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
  return p;
}
async function legacyRows() {
  return prisma.address.findMany({ where: { legacyImport: true }, orderBy: [{ chain: "asc" }, { derivationIndex: "asc" }], select: { chain: true, address: true, derivationIndex: true, keyId: true, reference: true } });
}
async function cursors() {
  const rows = await prisma.scanCursor.findMany({ select: { chain: true, lastScannedBlock: true, legacyWatchEnabledAt: true } });
  return Object.fromEntries(rows.map((r) => [r.chain, { block: r.lastScannedBlock.toString(), stamped: r.legacyWatchEnabledAt !== null }]));
}
async function mkKey(kind: "merchant" | "partner", tag: string) {
  const client = await prisma.client.create({ data: { name: `vlh-${tag}-${RUN}`, kind }, select: { id: true } });
  return prisma.clientKey.create({ data: { clientId: client.id, name: tag, keyPrefix: `v${tag}${RUN}`.slice(0, 12).padEnd(12, "x"), keyHash: "not-a-real-hash", keyLast4: "0000", scopes: [], environment: "test", issuedBy: "verify", issuedVia: "cli" }, select: { id: true } });
}

async function main() {
  console.log(`database: ${await assertSandboxDatabase()}`);
  if (await prisma.cryptoConfig.findUnique({ where: { id: 1 } })) throw new Error("crypto_config already has a row — this script needs a fresh throwaway database");
  const seed = await bip39.mnemonicToSeed(bip39.generateMnemonic(256));
  await saveMasterSeedConfig(seed);

  const mA = `mA${RUN}`, mB = `mB${RUN}`;
  const keyA = await mkKey("merchant", "a");
  const keyB = await mkKey("merchant", "b");
  const partner = await mkKey("partner", "p");
  const spec: Array<[Chain, number, string, string]> = [
    ["TRC20", 3, mA, "u1"], ["TRC20", 7, mA, "u2"], ["TRC20", 112, mB, "u3"],
    ["BEP20", 3, mA, "u1"], ["BEP20", 9, mB, "u4"], ["BEP20", 122, mB, "u5"],
  ];
  const good = spec.map(([chain, derivationIndex, merchantId, userId]) => ({ chain, address: deriveAddress(seed, chain, derivationIndex), derivationIndex, userId, merchantId }));
  const goodFile = file("export.json", good);
  const keys = [`--key=${mA}:${keyA.id}`, `--key=${mB}:${keyB.id}`];

  // ── 1. re-derivation mismatch ────────────────────────────────────────────
  const lying = good.map((r, i) => (i === 4 ? { ...r, address: deriveAddress(seed, r.chain, r.derivationIndex + 1) } : r));
  let r = run(IMPORT, [`--in=${file("lying.json", lying)}`, ...keys, "--apply"]);
  let rows = await legacyRows();
  check(r.code === 3 && /re-derive/.test(r.out), "1. an address that does not re-derive at its index is REFUSED (exit 3, names re-derivation)", `exit ${r.code}`);
  check(rows.length === 0, "1b. ... and NOTHING was written — not even the five good rows", `${rows.length} rows`);

  // ── 2. key mapping ───────────────────────────────────────────────────────
  r = run(IMPORT, [`--in=${goodFile}`, keys[0]!, "--apply"]);
  check(r.code === 3 && /no --key for merchant/.test(r.out) && (await legacyRows()).length === 0, "2. a merchant with no --key is REFUSED, nothing written", `exit ${r.code}`);
  r = run(IMPORT, [`--in=${goodFile}`, keys[0]!, `--key=${mB}:${partner.id}`, "--apply"]);
  check(r.code === 3 && /not a merchant/.test(r.out) && (await legacyRows()).length === 0, "2b. a key of a non-merchant client is REFUSED, nothing written", `exit ${r.code}`);

  // ── 3. dry run ───────────────────────────────────────────────────────────
  r = run(IMPORT, [`--in=${goodFile}`, ...keys, "--expect=6"]);
  check(r.code === 0 && /WOULD insert 6/.test(r.out) && (await legacyRows()).length === 0, "3. without --apply: plans 6, writes 0", `exit ${r.code}`);

  // ── 4. apply ─────────────────────────────────────────────────────────────
  r = run(IMPORT, [`--in=${goodFile}`, ...keys, "--expect=6", "--apply"]);
  rows = await legacyRows();
  const want = good.map((g) => ({ chain: g.chain, address: g.address, derivationIndex: g.derivationIndex, keyId: g.merchantId === mA ? keyA.id : keyB.id, reference: `samaprime:${g.merchantId}:user:${g.userId}` }))
    .sort((a, b) => a.chain.localeCompare(b.chain) || a.derivationIndex - b.derivationIndex);
  check(r.code === 0 && /inserted 6/.test(r.out), "4. --apply inserts 6", `exit ${r.code}`);
  check(JSON.stringify(rows) === JSON.stringify(want), "4b. every row EXACTLY: address, index, its OWN merchant's key, reference samaprime:<merchantId>:user:<userId>, legacy_import", JSON.stringify(rows[0]));
  check(Object.keys(await cursors()).length === 0, "4c. the import never touches scan_cursors (watching starts only at 5b)");

  // ── 5. idempotent ────────────────────────────────────────────────────────
  const auditBefore = await prisma.auditEvent.count();
  r = run(IMPORT, [`--in=${goodFile}`, ...keys, "--apply"]);
  check(r.code === 0 && /inserted 0, already present 6/.test(r.out), "5. a second --apply writes 0 (6 already present)", `exit ${r.code}`);
  check((await legacyRows()).length === 6 && (await prisma.auditEvent.count()) === auditBefore, "5b. row count and audit count unchanged by the second run");

  // ── 6. existing row that differs ─────────────────────────────────────────
  r = run(IMPORT, [`--in=${goodFile}`, `--key=${mA}:${keyB.id}`, `--key=${mB}:${keyB.id}`, "--apply"]);
  check(r.code === 3 && /differs/.test(r.out) && JSON.stringify(await legacyRows()) === JSON.stringify(want), "6. re-import under a DIFFERENT key is REFUSED and no row changed", `exit ${r.code}`);

  // ── handoff (contract v1.1 A2) ───────────────────────────────────────────
  // target(chain) = MIN(SamaPay cursor, MNTAD final − SamaPay confirmation depth):
  // only BACK or stay. Depth read from getChainConfig, the observer's own source.
  const d = { TRC20: BigInt(getChainConfig("TRC20").confirmationsRequired), BEP20: BigInt(getChainConfig("BEP20").confirmationsRequired) };
  // Imported dynamically so the import half still runs (and reports) when the module is absent.
  const handoffTarget = await import("@/chain/cursor.js").then((m) => m.handoffTarget).catch(() => null);
  check(handoffTarget !== null && handoffTarget(700n, 653n, 3n) === 650n && handoffTarget(500n, 800n, 3n) === 500n && handoffTarget(null, 800n, 3n) === 797n && handoffTarget(null, 2n, 3n) === 0n,
    "H0. handoffTarget = MIN(current, mntad − depth); no SamaPay cursor → mntad − depth; never below 0");
  // SamaPay's observer has been running: TRC20 AHEAD of MNTAD's stop, BEP20 BEHIND it.
  await prisma.scanCursor.create({ data: { chain: "TRC20", lastScannedBlock: 700n } });
  await prisma.scanCursor.create({ data: { chain: "BEP20", lastScannedBlock: 500n } });
  const legacyTrc = await prisma.address.findFirstOrThrow({ where: { chain: "TRC20", legacyImport: true }, select: { id: true, keyId: true } });
  await prisma.deposit.create({ data: { keyId: legacyTrc.keyId, addressId: legacyTrc.id, chain: "TRC20", txHash: `vlh-${RUN}`, amount: "1", blockNumber: 600n } });
  const stoppedAt = "2026-09-24T12:00:00.000Z";
  const initial = JSON.stringify({ BEP20: { block: "500", stamped: false }, TRC20: { block: "700", stamped: false } });
  const snap = async () => { const c = await cursors(); return JSON.stringify({ BEP20: c.BEP20, TRC20: c.TRC20 }); };

  // 7. file shape
  r = run(WATCH, [`--cursors=${file("c-missing.json", { TRC20: 653, stoppedAt })}`, "--apply"]);
  check(r.code === 3 && /no BEP20/.test(r.out) && (await snap()) === initial, "7. a cursor file without BEP20 is REFUSED, cursors unchanged", `exit ${r.code}`);
  r = run(WATCH, [`--cursors=${file("c-extra.json", { TRC20: 653, BEP20: 800, stoppedAt, ETH: 1 })}`, "--apply"]);
  check(r.code === 3 && (await snap()) === initial, "7b. a cursor file with an extra key is REFUSED (shape is exact)", `exit ${r.code}`);

  // 8. rewinding below recorded legacy history
  r = run(WATCH, [`--cursors=${file("c-back.json", { TRC20: Number(599n + d.TRC20), BEP20: 800, stoppedAt })}`, "--apply"]);
  check(r.code === 3 && /backwards/.test(r.out) && (await snap()) === initial, "8. TRC20 target 599 < a legacy deposit SamaPay recorded at 600: REFUSED, and BEP20 NOT touched either (one transaction)", `exit ${r.code}`);

  // 9. dry run
  const cFile = file("cursors.json", { TRC20: Number(650n + d.TRC20), BEP20: 800, stoppedAt });
  // 8b. not mainnet → refused unless --rehearsal (the depth would be testnet's 3)
  r = run(WATCH, [`--cursors=${cFile}`, "--apply"], { CRYPTO_MODE: "testnet" });
  check(r.code === 3 && /not mainnet/.test(r.out) && r.out.includes("network: testnet") && (await snap()) === initial, "8b. CRYPTO_MODE=testnet without --rehearsal: REFUSED (exit 3) after printing the mode, nothing written", `exit ${r.code}`);
  r = run(WATCH, [`--cursors=${cFile}`, "--rehearsal"], { CRYPTO_MODE: "testnet", CRYPTO_TRON_TESTNET_USDT_CONTRACT: "rehearsal-not-dialled", CRYPTO_BSC_TESTNET_USDT_CONTRACT: "rehearsal-not-dialled" });
  check(r.code === 0 && r.out.includes("network: testnet") && (await snap()) === initial, "8c. ... with --rehearsal the testnet dry run proceeds (and still writes nothing)", `exit ${r.code}`);
  r = run(WATCH, [`--cursors=${cFile}`]);
  check(r.code === 0 && /TRC20: WOULD SET cursor 700 -> 650; re-scan 50/.test(r.out) && (await snap()) === initial, "9. dry run prints the rewind (TRC20 700 -> 650, 50 blocks) and writes nothing", `exit ${r.code}`);
  check(r.out.includes(`network: mainnet; confirmation depth TRC20 ${d.TRC20}, BEP20 ${d.BEP20}`), "9b. the dry run prints the network and the depth it subtracts, per chain");

  // 10. apply: ahead moves back to the MIN, behind stays, both stamped
  r = run(WATCH, [`--cursors=${cFile}`, "--apply"]);
  const after = await snap();
  check(r.code === 0 && after === JSON.stringify({ BEP20: { block: "500", stamped: true }, TRC20: { block: "650", stamped: true } }),
    `10. --apply: TRC20 (ahead, 700) moves BACK to MNTAD ${650n + d.TRC20} − depth ${d.TRC20} = 650; BEP20 (behind, 500 < 800 − ${d.BEP20}) STAYS at 500; legacy watch stamped on both`, after);
  check(r.out.includes(`network: mainnet; confirmation depth TRC20 ${d.TRC20}, BEP20 ${d.BEP20}`), "10b. --apply prints the same network + per-chain depth line as the dry run");

  // 11. re-runnable from the saved file, no change — also after the observer moved on
  r = run(WATCH, [`--cursors=${cFile}`, "--apply"]);
  check(r.code === 0 && /ALREADY ENABLED/.test(r.out) && (await snap()) === after, "11. the same file again: no change", `exit ${r.code}`);
  await prisma.scanCursor.update({ where: { chain: "TRC20" }, data: { lastScannedBlock: 900n } });
  const moved = await snap();
  r = run(WATCH, [`--cursors=${cFile}`, "--apply"]);
  check(r.code === 0 && (await snap()) === moved, "11b. re-run after the observer advanced to 900: no rewind, no change", `exit ${r.code}`);

  // 12. import after the handoff
  const extra = [...good, { chain: "TRC20" as Chain, address: deriveAddress(seed, "TRC20", 50), derivationIndex: 50, userId: "u9", merchantId: mA }];
  r = run(IMPORT, [`--in=${file("late.json", extra)}`, ...keys, "--apply"]);
  check(r.code === 3 && /already started/.test(r.out) && (await legacyRows()).length === 6, "12. a NEW legacy row after the handoff is REFUSED", `exit ${r.code}`);

  // 13. the import never sets watch_disabled_at (reserved for explicit disables)
  check((await prisma.address.count({ where: { legacyImport: true, watchDisabledAt: { not: null } } })) === 0, "13. imported legacy rows carry watch_disabled_at NULL");
}

main()
  .catch((e) => { check(false, "the run itself threw", String(e)); })
  .finally(async () => {
    const code = summary();
    await prisma.$disconnect();
    process.exit(code);
  });
