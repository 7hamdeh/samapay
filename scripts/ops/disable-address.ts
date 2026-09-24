// CONTRACT §9 STEP 0 — stop watching ONE address. Sets
// addresses.watch_disabled_at; the observer skips any address where it is set.
//
//   DRY RUN (default, writes nothing):
//     pnpm exec tsx --env-file=.env scripts/ops/disable-address.ts --address=TNX7jtfaGHGjdSHzxHt9FhnFVmHvkQ2b9k
//   APPLY (Ibrahim's keystroke, after a fresh SamaPay backup):
//     … --address=<addr> --apply --backup=/absolute/path/to/samapay-dump --by=ibrahim [--reason="old seed 02e0fb61"]
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
//
// BACKUP GATE (--apply only): --backup names an existing, non-empty,
// absolute file whose mtime is within BACKUP_MAX_AGE_MS AND later than the
// newest ops/CLI audit row (actor `ops:*` or `cli:*`) — a dump taken BEFORE
// the previous hand-run write does not cover this one.
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";

export const BACKUP_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const Args = z.object({
  address: z.string().min(20).max(100).regex(/^[A-Za-z0-9]+$/, "an address is alphanumeric"),
  apply: z.boolean(),
  backup: z.string().optional(),
  by: z.string().regex(/^[a-z][a-z0-9_-]{1,40}$/).optional(),
  reason: z.string().min(1).max(200).optional(),
}).strict();
export type DisableArgs = z.infer<typeof Args>;

export function parseArgs(argv: readonly string[]): DisableArgs {
  const raw: Record<string, unknown> = { apply: false };
  for (const a of argv) {
    if (a === "--apply") { raw.apply = true; continue; }
    const m = /^--(address|backup|by|reason)=(.*)$/.exec(a);
    if (m) { raw[m[1] as string] = m[2]; continue; }
    throw new Error(`unknown argument ${a} (use --address=… [--apply --backup=… --by=…] [--reason=…])`);
  }
  const parsed = Args.safeParse(raw);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `--${i.path.join(".")}: ${i.message}`).join("; "));
  if (parsed.data.apply && (!parsed.data.backup || !parsed.data.by)) throw new Error("--apply needs --backup=<absolute path> and --by=<who>");
  return parsed.data;
}

/** Returns null when the backup gate passes, else the reason it does not. */
export async function backupProblem(db: PrismaClient, path: string | undefined, now = Date.now()): Promise<string | null> {
  if (!path) return "no --backup given";
  if (!isAbsolute(path)) return `backup path ${path} is not absolute`;
  let st;
  try { st = statSync(path); } catch { return `backup ${path} does not exist`; }
  if (!st.isFile() || st.size === 0) return `backup ${path} is not a non-empty file`;
  if (now - st.mtimeMs > BACKUP_MAX_AGE_MS) return `backup ${path} is older than ${BACKUP_MAX_AGE_MS / 3_600_000} h`;
  const last = await db.auditEvent.findFirst({ where: { OR: [{ actor: { startsWith: "ops:" } }, { actor: { startsWith: "cli:" } }] }, orderBy: { at: "desc" }, select: { at: true, action: true } });
  if (last && st.mtimeMs <= last.at.getTime()) return `backup ${path} predates the last hand-run write (${last.action} at ${last.at.toISOString()})`;
  return null;
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

async function main() {
  const { logger } = await import("@/log.js");
  let args: DisableArgs;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(`REFUSING: ${(e as Error).message}`); process.exit(2); }
  const { prisma } = await import("@/db/client.js");
  const db = (await prisma.$queryRawUnsafe("select current_database() as db")) as Array<{ db: string }>;
  console.log(`database: ${db[0]?.db}   mode: ${args.apply ? "APPLY" : "DRY RUN (nothing is written)"}`);
  if (args.apply) {
    const problem = await backupProblem(prisma, args.backup);
    if (problem) { console.error(`REFUSING --apply: ${problem}`); await prisma.$disconnect(); process.exit(2); }
  }
  const r = await disableAddress(prisma, args);
  console.log(JSON.stringify(r, null, 2));
  logger.info({ actor: `ops:${args.by ?? "dry-run"}`, action: "address.watch_disable", address: args.address, result: r.outcome }, "disable-address");
  await prisma.$disconnect();
  process.exit(r.outcome === "not_found" || r.outcome === "ambiguous" ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e instanceof Error ? `${e.name}: ${e.message}` : e); process.exit(1); });
}
