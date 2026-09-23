// COVERS: src/chain/derivation-floor.ts src/chain/live.ts src/server.ts
//
// S2 slice 1, step 2 (index floor) — RED-FIRST. Decision #80: SamaPay derives
// from the SAME seed as MNTAD (a4434b0b). MNTAD has issued user indices up to
// TRC20 112 / BEP20 122 (measured 2026-09-23), so SamaPay must NEVER derive at
// or below a configured per-chain floor that sits above those — enforced in
// CODE at derivation time and validated at BOOT, not left to convention.
//
// Throwaway material only: SEED_ENCRYPTION_KEY and a fresh BIP39 seed are
// generated in this process (the repo's generate-master-seed path:
// bip39 → saveMasterSeedConfig), on a disposable cluster. No real seed/key.
import crypto from "node:crypto";
process.env.SEED_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as bip39 from "bip39";
import { assertSandboxDatabase } from "@/db/guard.js";
import { prisma } from "@/db/client.js";
import { saveMasterSeedConfig, wipeMasterSeedCache } from "@/chain/seed/master-seed.js";
import { deriveAddress } from "@/chain/hd/derive.js";
import { liveDeriver } from "@/chain/live.js";
import { assertDerivationFloorsConfigured, derivationFloor, MNTAD_MAX_ISSUED_INDEX, MIN_FLOOR_MARGIN, nextIndexAboveFloor } from "@/chain/derivation-floor.js";
import { check, summary, thrown } from "./lib/check.js";

const RUN = Date.now().toString(36);
const ENV = { TRC20: "SAMAPAY_DERIVATION_FLOOR_TRC20", BEP20: "SAMAPAY_DERIVATION_FLOOR_BEP20" } as const;
function setFloors(trc: string | undefined, bep: string | undefined) {
  if (trc === undefined) delete process.env[ENV.TRC20]; else process.env[ENV.TRC20] = trc;
  if (bep === undefined) delete process.env[ENV.BEP20]; else process.env[ENV.BEP20] = bep;
}
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) { const p = join(dir, e); if (statSync(p).isDirectory()) walk(p, out); else out.push(p); }
  return out;
}

async function main() {
  console.log(`database: ${await assertSandboxDatabase()}`);
  let weCreatedSeed = false;
  const client = await prisma.client.create({ data: { name: `verify-floor-${RUN}`, kind: "partner" }, select: { id: true } });
  const key = await prisma.clientKey.create({ data: { clientId: client.id, name: "floor", keyPrefix: `vfl_${RUN}`.slice(0, 12).padEnd(12, "x"), keyHash: "not-a-real-hash", keyLast4: "0000", scopes: [], environment: "test", issuedBy: "verify", issuedVia: "cli" }, select: { id: true } });
  try {
    // ── boot-time validation ─────────────────────────────────────────────
    check(MNTAD_MAX_ISSUED_INDEX.TRC20 === 112 && MNTAD_MAX_ISSUED_INDEX.BEP20 === 122, "0. the measured MNTAD maxima are pinned in code (TRC20 112, BEP20 122)");
    setFloors(undefined, undefined);
    check((await thrown(async () => assertDerivationFloorsConfigured())).name !== "NO THROW", "1. boot REFUSES when the floors are not configured");
    for (const bad of ["112", String(MNTAD_MAX_ISSUED_INDEX.TRC20 + MIN_FLOOR_MARGIN - 1), "abc", "1e4", "-5", "1000.5", " 1000", ""]) {
      setFloors(bad, "5000");
      const r = await thrown(async () => assertDerivationFloorsConfigured());
      check(r.name !== "NO THROW", `2. boot REFUSES TRC20 floor ${JSON.stringify(bad)} (must be an integer ≥ MNTAD max + ${MIN_FLOOR_MARGIN})`, r.name);
    }
    setFloors("5000", String(MNTAD_MAX_ISSUED_INDEX.BEP20 + MIN_FLOOR_MARGIN - 1));
    check((await thrown(async () => assertDerivationFloorsConfigured())).name !== "NO THROW", "2b. boot REFUSES a BEP20 floor one below MNTAD max + margin");
    setFloors(String(MNTAD_MAX_ISSUED_INDEX.TRC20 + MIN_FLOOR_MARGIN), String(MNTAD_MAX_ISSUED_INDEX.BEP20 + MIN_FLOOR_MARGIN));
    const ok = await thrown(async () => assertDerivationFloorsConfigured());
    check(ok.name === "NO THROW", "3. boot ACCEPTS floors exactly at MNTAD max + margin (bound checked from both sides)", ok.name);

    // server.ts refuses to start without them (spawned, never listens)
    const envNoFloor = { ...process.env }; delete envNoFloor[ENV.TRC20]; delete envNoFloor[ENV.BEP20];
    const srv = spawnSync("./node_modules/.bin/tsx", ["src/server.ts"], { env: { ...envNoFloor, PORT: "0" }, encoding: "utf8", timeout: 30_000 });
    check(srv.status !== 0 && srv.status !== null && /DERIVATION_FLOOR/.test(srv.stderr + srv.stdout), "4. src/server.ts exits non-zero at boot without the floors", `exit=${srv.status} ${(srv.stderr || srv.stdout).trim().split("\n").find((l) => /FLOOR/.test(l))?.slice(0, 120) ?? ""}`);

    // ── derivation with a throwaway seed ─────────────────────────────────
    if ((await prisma.cryptoConfig.count()) !== 0) throw new Error("crypto_config is not empty on this disposable database — refusing to plant a test seed");
    const seed = await bip39.mnemonicToSeed(bip39.generateMnemonic(256));
    await saveMasterSeedConfig(seed); weCreatedSeed = true;
    wipeMasterSeedCache();
    setFloors("1000", "2000");
    const t1 = await liveDeriver.deriveNext("TRC20");
    const b1 = await liveDeriver.deriveNext("BEP20");
    check(t1.derivationIndex === 1001 && b1.derivationIndex === 2001, "5. an empty chain derives at floor + 1, never 0", `TRC20 ${t1.derivationIndex}, BEP20 ${b1.derivationIndex}`);
    check(t1.address === deriveAddress(seed, "TRC20", 1001) && b1.address === deriveAddress(seed, "BEP20", 2001), "5b. the address is the seed's address AT that index (same derivation as MNTAD's paths)");
    check(t1.derivationIndex > MNTAD_MAX_ISSUED_INDEX.TRC20 && b1.derivationIndex > MNTAD_MAX_ISSUED_INDEX.BEP20, "5c. both are above MNTAD's highest issued index");

    // a row BELOW the floor (e.g. an imported legacy address) must not pull the next index down
    await prisma.address.create({ data: { keyId: key.id, reference: "verify:floor:legacy:5", chain: "TRC20", address: `Tverifyfloor${RUN}5`, derivationIndex: 5, legacyImport: true } });
    const t2 = await liveDeriver.deriveNext("TRC20");
    check(t2.derivationIndex === 1001, "6. a legacy row at index 5 does NOT make the next index 6 — floor + 1 still wins", `next=${t2.derivationIndex}`);
    // a row ABOVE the floor keeps the sequence monotonic from there (SamaPay's own 1000000 in production)
    await prisma.address.create({ data: { keyId: key.id, reference: "verify:floor:high:1", chain: "TRC20", address: `Tverifyfloor${RUN}hi`, derivationIndex: 1_000_000 } });
    const t3 = await liveDeriver.deriveNext("TRC20");
    check(t3.derivationIndex === 1_000_001, "7. above the floor the next index is highest + 1", `next=${t3.derivationIndex}`);

    // the pure rule, both sides
    check(nextIndexAboveFloor(null, 1000) === 1001 && nextIndexAboveFloor(1000, 1000) === 1001 && nextIndexAboveFloor(999, 1000) === 1001 && nextIndexAboveFloor(1001, 1000) === 1002, "8. nextIndexAboveFloor: max(highest + 1, floor + 1)");
    setFloors(undefined, undefined);
    const unset = await thrown(() => liveDeriver.deriveNext("BEP20"));
    check(unset.name !== "NO THROW", "9. the deriver itself REFUSES when the floor is unset at call time (not only at boot)", unset.name);
    setFloors("1000", "2000");
    check(derivationFloor("TRC20") === 1000 && derivationFloor("BEP20") === 2000, "9b. each chain reads its OWN floor");

    // ── step 3: nothing keeps the written-off seed or its address special ──
    const code = [...walk("src"), ...walk("scripts")].filter((p) => p.endsWith(".ts") && !p.endsWith("verify-derivation-floor.ts"));
    const hits = code.filter((p) => /02e0fb61|TNX7jtfaGHGjdSHzxHt9FhnFVmHvkQ2b9k/.test(readFileSync(p, "utf8")));
    const docHits = walk("docs").filter((p) => /02e0fb61/.test(readFileSync(p, "utf8")));
    check(docHits.length > 0 && hits.length === 0, "10. no src/ or scripts/ file names seed 02e0fb61 or TNX7j… (CONTROL: the same scan finds it in docs/)", `code hits=${hits.length} over ${code.length} files; docs hits=${docHits.length}`);
  } catch (err) {
    check(false, "THE SUITE THREW — nothing below this point ran", String(err instanceof Error ? err.stack : err));
  } finally {
    await prisma.address.deleteMany({ where: { keyId: key.id } }).catch(() => undefined);
    if (weCreatedSeed) await prisma.cryptoConfig.deleteMany({ where: { id: 1 } }).catch(() => undefined);
    wipeMasterSeedCache();
    await prisma.clientKey.deleteMany({ where: { id: key.id } }).catch(() => undefined);
    await prisma.client.deleteMany({ where: { id: client.id } }).catch(() => undefined);
    await prisma.$disconnect();
  }
  process.exit(summary());
}
main().catch((e) => { console.error("verify-derivation-floor crashed:", e); process.exit(1); });
