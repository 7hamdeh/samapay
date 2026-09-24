// CONTRACT §9 STEP 4 — register MNTAD's legacy deposit addresses in SamaPay so
// that, after the handoff (step 5b, scripts/ops/start-legacy-watch.ts), SamaPay
// observes and reports them. Ported from session/allowance c82f296 and adapted
// to decision #80 + the Phase 0 contract:
//   - each merchant's addresses go under THAT merchant's key (a `merchant`
//     client), not one platform key — M1 refuses a deposit.confirmed whose
//     reference names a merchant other than the credential's;
//   - client_id = the key's client (v1.1 A12), written on every row;
//   - reference `samaprime:<merchantId>:user:<userId>` (src/reference format),
//     no longer `legacy:none`;
//   - EVERY address must re-derive from the seed in crypto_config (the imported
//     a4434b0b) at its index before anything is written.
//
// INPUT (--in): the JSON file MNTAD's scripts/ops/s2/export-legacy-addresses.ts
// (agent M3, read-only) writes, EXACTLY:
//   [{"chain": "TRC20"|"BEP20", "address": "…", "derivationIndex": <int>,
//     "userId": "…", "merchantId": "…"}, …]
//
// USAGE:
//   pnpm exec tsx scripts/import-legacy-addresses.ts --in=<file> \
//     --key=<merchantId>:<keyId> [--key=<merchantId>:<keyId> …] [--expect=<N>] [--apply] [--by=<who>]
//
// DRY RUN BY DEFAULT: every check runs and the plan is printed; nothing is
// written without --apply. With --apply the inserts are ONE transaction.
//
// REFUSES (whole run, nothing written) when:
//   - the file does not match the shape above, or --expect disagrees with it;
//   - a (chain, address) or (chain, derivationIndex) repeats in the file;
//   - an index is at or above the chain's configured derivation floor (that
//     range belongs to SamaPay's own derivations);
//   - an address does not re-derive from the stored seed at its index;
//   - a merchantId has no --key, or the key is missing, inactive, revoked, or
//     not a `merchant` client's key;
//   - an existing row at the same (chain, address) or (chain, index) differs in
//     ANY field from what this run would write (address, index, key,
//     client_id, reference, legacy_import) — never overwritten, never "fixed".
// IDEMPOTENT: rows already present exactly as planned are skipped; a second
// run writes 0.
//
// Watching: imported rows are NOT observed until step 5b stamps
// scan_cursors.legacy_watch_enabled_at for the chain (G6 schema; the observer
// skips legacy_import addresses while it is null). This script never touches
// the cursor. Importing NEW rows after the handoff is refused: they would be
// watched from the current cursor, not from MNTAD's stop block.
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Chain } from "@prisma/client";
import { prisma } from "@/db/client.js";
import logger from "@/log.js";
import { appendAudit } from "@/audit/append.js";
import { deriveAddress } from "@/chain/hd/derive.js";
import { derivationFloor } from "@/chain/derivation-floor.js";
import { loadMasterSeed, wipeMasterSeedCache } from "@/chain/seed/master-seed.js";
import { buildReference } from "@/reference/index.js";

const log = logger.child({ mod: "import-legacy-addresses" });

const RowSchema = z.object({
  chain: z.enum(["TRC20", "BEP20"]),
  address: z.string().min(1).max(128),
  derivationIndex: z.number().int().nonnegative(),
  userId: z.string().min(1),
  merchantId: z.string().min(1),
}).strict();
const FileSchema = z.array(RowSchema).min(1);
type Row = z.infer<typeof RowSchema>;

class Refused extends Error {}
class DryRunRollback extends Error {}

function flag(name: string): string | undefined {
  const pre = `--${name}=`;
  return process.argv.find((a) => a.startsWith(pre))?.slice(pre.length);
}
function flags(name: string): string[] {
  const pre = `--${name}=`;
  return process.argv.filter((a) => a.startsWith(pre)).map((a) => a.slice(pre.length));
}
/** BEP20 is hex (case is only a checksum); TRON base58 is case-significant. Same rule as src/observer. */
function sameAddress(chain: Chain, a: string, b: string): boolean {
  return chain === "BEP20" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

interface Planned { chain: Chain; address: string; derivationIndex: number; keyId: string; clientId: string; reference: string }

async function main(): Promise<number> {
  const file = flag("in");
  const apply = process.argv.includes("--apply");
  const by = flag("by") ?? "ibrahim";
  const expectRaw = flag("expect");
  if (!file) { console.error("usage: tsx scripts/import-legacy-addresses.ts --in=<file> --key=<merchantId>:<keyId>… [--expect=N] [--apply]"); return 2; }

  // ── the file ────────────────────────────────────────────────────────────
  let json: unknown;
  try { json = JSON.parse(readFileSync(file, "utf8")); } catch { throw new Refused("input file is not JSON"); }
  const parsed = FileSchema.safeParse(json);
  if (!parsed.success) throw new Refused(`input does not match [{chain, address, derivationIndex, userId, merchantId}]: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const rows: Row[] = parsed.data;
  if (expectRaw !== undefined && String(rows.length) !== expectRaw) throw new Refused(`--expect=${expectRaw} but the file carries ${rows.length} rows`);
  const addrKeys = new Set(rows.map((r) => `${r.chain}|${r.chain === "BEP20" ? r.address.toLowerCase() : r.address}`));
  const idxKeys = new Set(rows.map((r) => `${r.chain}|${r.derivationIndex}`));
  if (addrKeys.size !== rows.length) throw new Refused(`duplicate (chain, address) in the file: ${rows.length - addrKeys.size}`);
  if (idxKeys.size !== rows.length) throw new Refused(`duplicate (chain, derivationIndex) in the file: ${rows.length - idxKeys.size}`);
  for (const r of rows) {
    const floor = derivationFloor(r.chain);
    if (r.derivationIndex >= floor) throw new Refused(`${r.chain} index ${r.derivationIndex} is at or above the derivation floor ${floor} — that range is SamaPay's own`);
  }

  // ── the keys ────────────────────────────────────────────────────────────
  const keyFor = new Map<string, string>();
  for (const k of flags("key")) {
    const m = /^([^:]+):([^:]+)$/.exec(k);
    if (!m) throw new Refused(`--key=${k} is not <merchantId>:<keyId>`);
    if (keyFor.has(m[1]!)) throw new Refused(`merchant ${m[1]} is mapped twice`);
    keyFor.set(m[1]!, m[2]!);
  }
  const merchants = [...new Set(rows.map((r) => r.merchantId))];
  // v1.1 A12: every address row carries its key's client_id, resolved here from the key itself.
  const clientFor = new Map<string, string>();
  const unmapped = merchants.filter((mId) => !keyFor.has(mId));
  if (unmapped.length) throw new Refused(`no --key for merchant(s) ${unmapped.join(", ")} — every legacy address must go under its own merchant's key`);
  for (const mId of merchants) {
    const keyId = keyFor.get(mId)!;
    const key = await prisma.clientKey.findUnique({ where: { id: keyId }, select: { active: true, revokedAt: true, clientId: true, client: { select: { kind: true } } } });
    if (!key) throw new Refused(`key ${keyId} (merchant ${mId}) does not exist`);
    if (!key.active || key.revokedAt) throw new Refused(`key ${keyId} (merchant ${mId}) is inactive or revoked`);
    if (key.client.kind !== "merchant") throw new Refused(`key ${keyId} (merchant ${mId}) belongs to a ${key.client.kind} client, not a merchant`);
    clientFor.set(mId, key.clientId);
  }

  // ── re-derivation: every address from the stored seed, before any write ─
  const seed = await loadMasterSeed();
  const config = await prisma.cryptoConfig.findUnique({ where: { id: 1 }, select: { seedFingerprint: true } });
  console.log(`seed fingerprint in crypto_config: ${config?.seedFingerprint ?? "<none>"}`);
  const planned: Planned[] = [];
  let mismatches = 0;
  for (const r of rows) {
    const derived = deriveAddress(seed, r.chain, r.derivationIndex);
    if (!sameAddress(r.chain, derived, r.address)) {
      mismatches += 1;
      console.error(`  MISMATCH ${r.chain} index ${r.derivationIndex}: file ${r.address.slice(0, 10)}… does not re-derive`);
      continue;
    }
    planned.push({ chain: r.chain, address: derived, derivationIndex: r.derivationIndex, keyId: keyFor.get(r.merchantId)!, clientId: clientFor.get(r.merchantId)!, reference: buildReference({ client: "samaprime", tenant: r.merchantId, kind: "user", id: r.userId }) });
  }
  wipeMasterSeedCache();
  if (mismatches) throw new Refused(`${mismatches} address(es) do not re-derive from the stored seed at their index`);

  // ── write (or not), in one transaction ──────────────────────────────────
  let inserted = 0;
  let present = 0;
  try {
    await prisma.$transaction(async (tx) => {
      const toInsert: Planned[] = [];
      for (const p of planned) {
        const existing = await tx.address.findMany({
          where: { chain: p.chain, OR: [{ derivationIndex: p.derivationIndex }, { address: { equals: p.address, mode: p.chain === "BEP20" ? "insensitive" : "default" } }] },
          select: { address: true, derivationIndex: true, keyId: true, clientId: true, reference: true, legacyImport: true },
        });
        if (existing.length === 0) { toInsert.push(p); continue; }
        const same = existing.length === 1 && existing.every((e) => sameAddress(p.chain, e.address, p.address) && e.derivationIndex === p.derivationIndex && e.keyId === p.keyId && e.clientId === p.clientId && e.reference === p.reference && e.legacyImport);
        if (!same) throw new Refused(`${p.chain} index ${p.derivationIndex}: an existing row differs from the planned one (address/index/key/client/reference/legacy_import) — refusing to overwrite`);
        present += 1;
      }
      if (toInsert.length) {
        const started = await tx.scanCursor.findMany({ where: { chain: { in: [...new Set(toInsert.map((p) => p.chain))] }, legacyWatchEnabledAt: { not: null } }, select: { chain: true } });
        if (started.length) throw new Refused(`legacy watch already started on ${started.map((s) => s.chain).join(", ")} — new legacy rows would be watched from the current cursor, not MNTAD's stop block`);
      }
      if (!apply) { inserted = toInsert.length; throw new DryRunRollback(); }
      for (const p of toInsert) {
        const row = await tx.address.create({ data: { keyId: p.keyId, clientId: p.clientId, reference: p.reference, chain: p.chain, address: p.address, derivationIndex: p.derivationIndex, legacyImport: true }, select: { id: true } });
        await appendAudit(tx, { keyId: p.keyId, actor: `admin:${by}`, action: "address.legacy_imported", subjectId: row.id, params: { chain: p.chain, derivationIndex: p.derivationIndex, reference: p.reference } });
      }
      inserted = toInsert.length;
    }, { timeout: 120_000 });
  } catch (e) {
    if (!(e instanceof DryRunRollback)) throw e;
  }

  console.log(`${apply ? "inserted" : "WOULD insert"} ${inserted}, already present ${present}, of ${rows.length} (TRC20 ${rows.filter((r) => r.chain === "TRC20").length}, BEP20 ${rows.filter((r) => r.chain === "BEP20").length}; ${merchants.length} merchant(s))`);
  if (!apply) console.log("DRY RUN — nothing was written; pass --apply");
  log.info({ actor: by, action: "legacy_addresses.import", result: apply ? "applied" : "dry_run", inserted, present, total: rows.length }, "import-legacy-addresses");
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e) => {
    const refused = e instanceof Refused;
    console.error(`${refused ? "REFUSED" : "FAILED"}: ${e instanceof Error ? e.message : String(e)} — nothing was written`);
    log.error({ action: "legacy_addresses.import", result: refused ? "refused" : "error", err: e instanceof Error ? e.message : String(e) }, "import-legacy-addresses");
    process.exitCode = refused ? 3 : 1;
  })
  .finally(async () => { wipeMasterSeedCache(); await prisma.$disconnect(); });
