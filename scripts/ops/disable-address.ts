// CONTRACT §9 STEP 0 — stop watching ONE address. Sets
// addresses.watch_disabled_at; the observer skips any address where it is set.
//
//   DRY RUN (default, writes nothing):
//     pnpm exec tsx --env-file=.env scripts/ops/disable-address.ts --address=<the written-off TRC20 address>
//   APPLY (Ibrahim's keystroke, right after /root/backups/samapay-backup.sh):
//     … --address=<addr> --apply --backup=/root/backups/samapay/samapay-<UTC>.dump.gpg [--by=ibrahim] [--reason=<text>]
//   REHEARSAL (throwaway only): add --rehearsal; the backup comes from env
//     SAMAPAY_OPS_REHEARSAL_BACKUP_DIR.
//
// ONE GATE FOR EVERY PHASE 0 OPS SCRIPT (review Q M3): src/chain/seed/ops-gate.ts
//   - openOpsRun: where-am-I. Refuses anything but the production database
//     (samapay on 5432), or with --rehearsal a *_sandbox DB away from 5432/5433.
//   - requireFreshBackup (--apply only): samapay-backup.sh's encrypted dump,
//     named samapay-<YYYY-MM-DDTHHMMSSZ>.dump.gpg in the backup dir, > 10 KiB,
//     at most 120 min old, with a matching .sha256 sidecar.
//   Exit codes (the gate's contract): 0 done / already done · 1 REFUSED · 3 FAILED.
//
// *** IT NEVER DELETES. *** The row stays: its derivation index stays taken
// (UNIQUE(chain, derivation_index)), its deposits stay readable, its audit
// history stays attached. A disabled address is re-enabled only by a later,
// separate, reviewed change — this script has no "enable".
//
// Idempotent: an address that is already disabled is reported and left alone
// (its original timestamp is kept). One address per run, matched EXACTLY
// (case-sensitive: TRON base58 is case-significant; a BEP20 address must be
// given as stored). A match on more than one chain is refused.
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";

const Values = z.object({
  address: z.string().min(20).max(100).regex(/^[A-Za-z0-9]+$/, "an address is alphanumeric"),
  by: z.string().regex(/^[a-z][a-z0-9_-]{1,40}$/),
  reason: z.string().min(1).max(200).optional(),
});
export type DisableValues = z.infer<typeof Values>;

/** Validates the gate's parsed values (--address, --by, --reason). --by defaults to "ibrahim": this is a hand-run ops script. */
export function disableValues(values: ReadonlyMap<string, string>): DisableValues {
  const parsed = Values.safeParse({ address: values.get("--address"), by: values.get("--by") ?? "ibrahim", reason: values.get("--reason") });
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `--${i.path.join(".")}: ${i.message}`).join("; "));
  return parsed.data;
}

export type DisableOutcome =
  | { outcome: "not_found" }
  | { outcome: "ambiguous"; chains: string[] }
  | { outcome: "already_disabled"; id: string; chain: string; watchDisabledAt: Date }
  | { outcome: "would_disable" | "disabled"; id: string; chain: string; derivationIndex: number; legacyImport: boolean; deposits: number; watchDisabledAt: Date | null };

/** The whole operation. `apply=false` reads only. With apply, one transaction: a guarded UPDATE (watch_disabled_at IS NULL) + one audit row. */
export async function disableAddress(db: PrismaClient, args: { address: string; apply: boolean; by?: string | undefined; reason?: string | undefined }): Promise<DisableOutcome> {
  const { appendAudit } = await import("@/audit/append.js");
  const rows = await db.address.findMany({ where: { address: args.address }, select: { id: true, chain: true, keyId: true, derivationIndex: true, legacyImport: true, watchDisabledAt: true, _count: { select: { deposits: true } } } });
  if (rows.length === 0) return { outcome: "not_found" };
  if (rows.length > 1) return { outcome: "ambiguous", chains: rows.map((r) => r.chain) };
  const row = rows[0]!;
  if (row.watchDisabledAt) return { outcome: "already_disabled", id: row.id, chain: row.chain, watchDisabledAt: row.watchDisabledAt };
  const base = { id: row.id, chain: row.chain, derivationIndex: row.derivationIndex, legacyImport: row.legacyImport, deposits: row._count.deposits };
  if (!args.apply) return { outcome: "would_disable", ...base, watchDisabledAt: null };
  return db.$transaction(async (tx) => {
    const at = new Date();
    // The status guard in the WHERE makes a concurrent second run a no-op, not a second stamp.
    const flipped = await tx.address.updateMany({ where: { id: row.id, watchDisabledAt: null }, data: { watchDisabledAt: at } });
    if (flipped.count === 0) {
      const now = await tx.address.findUniqueOrThrow({ where: { id: row.id }, select: { watchDisabledAt: true } });
      return { outcome: "already_disabled" as const, id: row.id, chain: row.chain, watchDisabledAt: now.watchDisabledAt as Date };
    }
    await appendAudit(tx, { keyId: row.keyId, actor: `ops:${args.by ?? "unknown"}`, action: "address.watch_disabled", subjectId: row.id, params: { chain: row.chain, address: args.address, derivationIndex: row.derivationIndex, reason: args.reason ?? null } });
    return { outcome: "disabled" as const, ...base, watchDisabledAt: at };
  });
}

async function main(): Promise<number> {
  const { parseOpsArgs, openOpsRun, backupDirFor, requireFreshBackup, OpsRefused } = await import("@/chain/seed/ops-gate.js");
  const { logger } = await import("@/log.js");
  const { prisma } = await import("@/db/client.js");
  try {
    const mode = parseOpsArgs(process.argv.slice(2), ["--address", "--by", "--reason"]);
    let v: DisableValues;
    try { v = disableValues(mode.values); } catch (e) { throw new OpsRefused((e as Error).message); }
    await openOpsRun("disable-address", mode);
    if (mode.apply) await requireFreshBackup(mode.values.get("--backup"), backupDirFor(mode));
    const r = await disableAddress(prisma, { address: v.address, apply: mode.apply, by: v.by, reason: v.reason });
    console.log(JSON.stringify(r, null, 2));
    logger.info({ actor: `ops:${v.by}`, action: "address.watch_disable", address: v.address, apply: mode.apply, result: r.outcome }, "disable-address");
    return r.outcome === "not_found" || r.outcome === "ambiguous" ? 1 : 0;
  } catch (e) {
    if (e instanceof OpsRefused) { console.error(`REFUSED: ${e.message}`); return 1; }
    console.error(`FAILED: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    return 3;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), () => process.exit(3));
}
