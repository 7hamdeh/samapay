// THE RISKIEST CUT STEP, REHEARSABLE BEFORE THE WINDOW: register
// SamaPrime's legacy deposit addresses under the platform key so they keep
// being scanned and credited after the cut. Decision (أ): they count for
// NOBODY's allowance — reference "legacy:none" — and they are marked
// legacy_import so nothing ever derives them anew.
//
// INPUT: a JSON file produced by SamaPrime's scripts/export-legacy-addresses.ts
//        (read-only over SamaPrime production):
//        [{ chain: "BEP20"|"TRC20", address, derivationIndex }]
// USAGE: pnpm verify:sandbox scripts/import-legacy-addresses.ts --key <keyId> --file <path> [--expect 192]
//        (the sandbox guard is the first statement; against production this is
//        the cut step itself and runs only on Ibrahim's keystroke)
//
// IDEMPOTENT: a second run inserts nothing and reports 0 new. Asserts the
// expected count, that every row is unique on (chain, address) and
// (chain, derivationIndex), and that nothing under the key changed on the
// re-run — the rehearsal is the assertion, not the insert.
import { readFileSync } from "node:fs";
import { assertSandboxDatabase } from "@/db/guard.js";
import { prisma } from "@/db/client.js";
import { check, summary } from "./lib/check.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const db = await assertSandboxDatabase().catch((e) => { throw e; });
  console.log(`database: ${db}`);
  const keyId = arg("key");
  const file = arg("file");
  const expect = Number(arg("expect") ?? "192");
  if (!keyId || !file) throw new Error("usage: --key <platform keyId> --file <export.json> [--expect N]");

  const rows = JSON.parse(readFileSync(file, "utf8")) as Array<{ chain: "BEP20" | "TRC20"; address: string; derivationIndex: number }>;
  check(rows.length === expect, `the export carries exactly ${expect} addresses`, `${rows.length}`);
  const byChainAddr = new Set(rows.map((r) => `${r.chain}|${r.address.toLowerCase()}`));
  const byChainIdx = new Set(rows.map((r) => `${r.chain}|${r.derivationIndex}`));
  check(byChainAddr.size === rows.length, "no duplicate (chain, address) in the export", `${byChainAddr.size}`);
  check(byChainIdx.size === rows.length, "no duplicate (chain, derivationIndex) in the export", `${byChainIdx.size}`);

  const key = await prisma.clientKey.findUnique({ where: { id: keyId }, select: { id: true, client: { select: { kind: true } } } });
  check(Boolean(key), "the target key exists", keyId);
  check(key?.client.kind === "platform", "the target key belongs to the PLATFORM client (legacy addresses are SamaPrime's)", key?.client.kind ?? "missing");
  if (!key) return;

  const before = await prisma.address.count({ where: { keyId, legacyImport: true } });
  let inserted = 0;
  let skipped = 0;
  for (const r of rows) {
    const existing = await prisma.address.findUnique({ where: { chain_address: { chain: r.chain, address: r.address } }, select: { id: true, keyId: true, legacyImport: true } });
    if (existing) {
      check(existing.keyId === keyId && existing.legacyImport, `existing ${r.chain} ${r.address.slice(0, 10)}… is already ours and legacy`, `${existing.keyId === keyId ? "same key" : "DIFFERENT KEY"}`);
      skipped += 1;
      continue;
    }
    await prisma.address.create({ data: { keyId, reference: "legacy:none", chain: r.chain, address: r.address, derivationIndex: r.derivationIndex, legacyImport: true } });
    inserted += 1;
  }
  const after = await prisma.address.count({ where: { keyId, legacyImport: true } });
  console.log(`inserted ${inserted}, skipped ${skipped}, legacy rows under key: ${before} -> ${after}`);
  check(after === expect, `*** ${expect} legacy addresses registered under the platform key ***`, `${after}`);
  check(inserted + skipped === rows.length, "every export row was either inserted or found", `${inserted}+${skipped}`);
  const noneRef = await prisma.address.count({ where: { keyId, legacyImport: true, reference: { not: "legacy:none" } } });
  check(noneRef === 0, "every legacy row carries reference legacy:none (counts for nobody — decision أ)", `${noneRef} otherwise`);

  // Idempotency, proven in the same run: re-import must be a no-op.
  let second = 0;
  for (const r of rows) {
    const existing = await prisma.address.findUnique({ where: { chain_address: { chain: r.chain, address: r.address } }, select: { id: true } });
    if (!existing) second += 1;
  }
  check(second === 0, "*** a second run would insert NOTHING (idempotent) ***", `${second} missing`);
}

main()
  .catch((e) => { check(false, "the run itself threw", String(e)); })
  .finally(async () => {
    const code = summary();
    await prisma.$disconnect();
    process.exit(code);
  });
