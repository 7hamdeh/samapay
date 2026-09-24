// Where-am-I + fresh-backup gate for the two seed CLIs (import-master-seed,
// prove-vault). Same contract as SamaPrime's scripts/ops/2026-09-23/post/_lib.ts:
//
//   - DRY RUN by default; `--apply` writes.
//   - Production mode: current_database() must be `samapay` on port 5432.
//     The import's `--apply` also needs `--backup=<file>`: the encrypted dump
//     /root/backups/samapay-backup.sh writes, exactly
//     /root/backups/samapay/samapay-<YYYY-MM-DDTHHMMSSZ>.dump.gpg, with its
//     REQUIRED <file>.sha256 sidecar (bare hex) matching, taken AFTER the last
//     write to crypto_config (its created_at, which the import sets).
//   - `--rehearsal`: the ONLY way to run anywhere else, and then only on a
//     `*_sandbox` database on 127.0.0.1 away from the real ports (5432/5433),
//     with the backup fixture dir from env SAMAPAY_OPS_REHEARSAL_BACKUP_DIR.
//   - exit 0 = done / already done · 1 = REFUSED · 3 = FAILED.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { prisma } from "@/db/client.js";
import { databaseNameFromUrl } from "@/db/guard.js";

export const PROD_DATABASE = "samapay";
export const PROD_PORT = 5432;
export const PROD_BACKUP_DIR = "/root/backups/samapay";
const BACKUP_NAME = /^samapay-(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z\.dump\.gpg$/;

export class OpsRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpsRefused";
  }
}
function expect(ok: boolean, message: string): void {
  if (!ok) throw new OpsRefused(message);
}

export interface OpsMode {
  apply: boolean;
  rehearsal: boolean;
  values: Map<string, string>;
}

/**
 * Strict argv parsing. An unknown argument is refused WITHOUT being printed:
 * the one thing that must never reach argv is a seed word, and a refusal that
 * echoed it would put it on the screen and in the shell's history twice.
 */
export function parseOpsArgs(argv: readonly string[], valueNames: readonly string[]): OpsMode {
  const values = new Map<string, string>();
  const ok = new Set(["--backup", ...valueNames]);
  let apply = false;
  let rehearsal = false;
  argv.forEach((a, i) => {
    const eq = a.indexOf("=");
    if (a === "--apply") apply = true;
    else if (a === "--rehearsal") rehearsal = true;
    else if (eq > 0 && ok.has(a.slice(0, eq))) values.set(a.slice(0, eq), a.slice(eq + 1));
    else throw new OpsRefused(`unknown argument #${i + 1} (not printed). Allowed: --apply --rehearsal ${[...ok].map((v) => `${v}=…`).join(" ")}`);
  });
  return { apply, rehearsal, values };
}

/** Prints the connection and refuses anything but production (or, with --rehearsal, a throwaway sandbox). */
export async function openOpsRun(script: string, mode: OpsMode): Promise<void> {
  const [id] = await prisma.$queryRaw<Array<{ db: string; port: number | null; host: string | null; ver: string }>>`
    select current_database() as db, inet_server_port() as port, host(inet_server_addr()) as host, current_setting('server_version') as ver`;
  expect(!!id, "could not identify the database");
  const where = id as { db: string; port: number | null; host: string | null; ver: string };
  console.log(script);
  console.log(`database: ${where.db}  host: ${where.host ?? "(socket)"}  port: ${where.port ?? "(socket)"}  server: ${where.ver}`);
  console.log(`mode: ${mode.apply ? "APPLY" : "DRY RUN"}${mode.rehearsal ? " (REHEARSAL)" : ""}\n`);
  if (mode.rehearsal) {
    expect(where.db.endsWith("_sandbox") && databaseNameFromUrl(process.env.DATABASE_URL) === where.db, `--rehearsal needs a *_sandbox database named by DATABASE_URL; connected to "${where.db}"`);
    expect(where.host === "127.0.0.1" && where.port !== null && where.port !== 5432 && where.port !== 5433, `--rehearsal refuses ${where.host}:${where.port} (a real cluster's address)`);
    return;
  }
  expect(where.db === PROD_DATABASE, `expected production database ${PROD_DATABASE}, connected to "${where.db}" (use --rehearsal only on a throwaway sandbox)`);
  expect(where.port === PROD_PORT, `expected production port ${PROD_PORT}, got ${where.port}`);
}

/** The backup directory this run's gate uses. */
export function backupDirFor(mode: OpsMode): string {
  if (!mode.rehearsal) return PROD_BACKUP_DIR;
  const dir = process.env.SAMAPAY_OPS_REHEARSAL_BACKUP_DIR;
  expect(!!dir && isAbsolute(dir) && resolve(dir) !== PROD_BACKUP_DIR, "--rehearsal --apply needs env SAMAPAY_OPS_REHEARSAL_BACKUP_DIR=<absolute fixture dir, not the production backup dir>");
  return dir as string;
}

/** Pure part of the gate: the path's SHAPE. Returns the stamp (UTC epoch ms) or a problem. */
export function backupPathShape(path: string, dir: string): { stampMs: number } | { problem: string } {
  if (!isAbsolute(path)) return { problem: `backup path ${path} must be absolute` };
  const abs = resolve(path);
  if (dirname(abs) !== resolve(dir)) return { problem: `backup ${path} is not in ${dir}` };
  const m = BACKUP_NAME.exec(basename(abs));
  if (!m) return { problem: `backup ${path} is not named samapay-<YYYY-MM-DDTHHMMSSZ>.dump.gpg (samapay-backup.sh's encrypted dump)` };
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const stampMs = Date.UTC(y, mo - 1, d, h, mi, se);
  const back = new Date(stampMs);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || back.getUTCHours() !== h || back.getUTCMinutes() !== mi || back.getUTCSeconds() !== se) {
    return { problem: `backup ${path}: the stamp in its name is not a real UTC time` };
  }
  return { stampMs };
}

/**
 * Epoch ms of the last write this gate orders against: crypto_config.created_at
 * (the import sets it; prove-vault's backup must postdate it). Read through the
 * Prisma client, which writes and reads this timestamp(3) column as UTC — never
 * via raw SQL now()/extract(), which would read it in the server's zone.
 */
export async function lastSeedWriteMs(): Promise<number | null> {
  const row = await prisma.cryptoConfig.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  return row ? row.createdAt.getTime() : null;
}

/**
 * Refuses unless `path` is a fresh dump: right dir + name, a regular file
 * > 10 KiB, matching its REQUIRED .sha256 sidecar, modified within 120 min and
 * not before its own stamp, started AND finished after the last seed write.
 */
export async function requireFreshBackup(path: string | undefined, dir: string): Promise<void> {
  expect(!!path, "--apply needs --backup=<path of the SamaPay dump taken just before this step>");
  const p = path as string;
  const shape = backupPathShape(p, dir);
  if ("problem" in shape) throw new OpsRefused(shape.problem);
  expect(existsSync(p), `backup ${p} does not exist`);
  const st = lstatSync(p);
  expect(st.isFile() && !st.isSymbolicLink(), `backup ${p} is not a regular file`);
  expect(st.size > 10_240, `backup ${p} is only ${st.size} bytes`);
  const now = Date.now();
  const ageMin = (now - st.mtimeMs) / 60_000;
  expect(ageMin <= 120, `backup ${p} is ${ageMin.toFixed(0)} minutes old — take a fresh one before this step`);
  expect(st.mtimeMs <= now + 60_000, `backup ${p} is modified in the future (${new Date(st.mtimeMs).toISOString()})`);
  expect(st.mtimeMs + 1_000 >= shape.stampMs, `backup ${p} was modified (${new Date(st.mtimeMs).toISOString()}) before the time in its own name`);
  const side = `${p}.sha256`;
  expect(existsSync(side) && lstatSync(side).isFile() && !lstatSync(side).isSymbolicLink(), `backup ${p} has no .sha256 sidecar (${side}) — samapay-backup.sh always writes one; refusing an unverified dump`);
  const want = readFileSync(side, "utf8").trim().split(/\s+/)[0] ?? "";
  expect(/^[0-9a-f]{64}$/.test(want), `backup sidecar ${side} does not hold a sha256`);
  const got = createHash("sha256").update(readFileSync(p)).digest("hex");
  expect(want === got, `backup ${p} does not match its .sha256 sidecar`);
  const last = await lastSeedWriteMs();
  if (last !== null) {
    expect(shape.stampMs > last && st.mtimeMs > last, `backup ${p} (started ${new Date(shape.stampMs).toISOString()}) is not newer than the last crypto_config write (${new Date(last).toISOString()}) — take a fresh backup now`);
  }
  console.log(`backup: ${p} (${st.size} bytes, ${ageMin.toFixed(0)} min old, sha256 ok; last crypto_config write ${last === null ? "none" : new Date(last).toISOString()})\n`);
}
