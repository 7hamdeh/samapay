// COVERS: prisma/migrations/20260925000000_phase0/migration.sql
//
// REHEARSAL OF THE REAL PHASE 0 MIGRATION FILE ON PRODUCTION-SHAPED ROWS
// (review Q M1). --check-migrations only ever replays the files into an EMPTY
// shadow, so the pre-check, the three backfill UPDATEs and the post-check had
// never run against a row. Here they do:
//
//   1. every migration BEFORE 20260925000000 is executed, in name order, on
//      the throwaway database (the state production will be in at step 1);
//   2. production-shaped rows are seeded (the real prod inventory, 2026-09-23
//      read-only inspection: ONE client "SamaPrime" kind platform, two keys,
//      ONE TRC20 address at derivation index 1000000 with a confirmed 3.01
//      deposit and ONE exhausted webhook delivery — plus what Phase 0 adds
//      next to it: a legacy-import row, a second (partner) client, a BEP20
//      detected deposit, an intent with its own address);
//   3. the phase0 FILE ITSELF (read from disk, byte for byte) is executed.
//
//   --case=clean          must succeed; every client_id equals its key's
//                         client; defaults land; the original columns of every
//                         pre-existing row are unchanged (md5 per table).
//   --case=dup-address    one extra address duplicating (client, chain,
//                         reference) → must RAISE the pre-check, and the
//                         catalog + every table's data must be byte-identical
//                         before and after (md5).
//   --case=dup-delivery   same, with a duplicate (key_id, event_id) delivery.
//
// RUN (one case per throwaway cluster, heavy slot):
//   bash /www/wwwroot/samaprime.com/scripts/throwaway-pg.sh \
//     ./node_modules/.bin/tsx scripts/verify-phase0-migration-rehearsal.ts --case=clean
//
// The SQL is executed with `prisma db execute --file` (the guard refuses
// `migrate deploy`). That sends the file as ONE multi-statement script, the
// same way the migration engine applies a migration file. The address below is
// a fixture; the real written-off address is never named in scripts/.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { prisma } from "@/db/client.js";
import { check, summary } from "./lib/check.js";

const PHASE0 = "20260925000000_phase0";
const TABLES = ["clients", "client_keys", "addresses", "deposits", "webhook_deliveries", "payment_intents"] as const;
// The columns each table had BEFORE phase0 — the "original data" hash covers exactly these.
const ORIGINAL: Record<(typeof TABLES)[number], string> = {
  clients: `id, name, kind, created_at`,
  client_keys: `id, client_id, name, key_prefix, key_hash, key_last4, scopes, environment, active, issued_by, issued_via, created_at`,
  addresses: `id, key_id, reference, chain, address, derivation_index, legacy_import, created_at`,
  deposits: `id, key_id, address_id, chain, tx_hash, amount, confirmations, status, block_number, detected_at, credited_at`,
  webhook_deliveries: `id, key_id, event_type, event_id, payload, attempts, status, created_at`,
  payment_intents: `id, client_id, key_id, address_id, chain, amount, reference, status, expires_at, created_at`,
};

function refuse(msg: string): never { console.error(`REFUSING (rehearsal): ${msg}`); process.exit(2); }

async function proveThrowaway(): Promise<string> {
  const raw = process.env.DATABASE_URL;
  if (!raw) refuse("DATABASE_URL is not set — run inside throwaway-pg.sh");
  let url: URL;
  try { url = new URL(raw); } catch { refuse("DATABASE_URL does not parse"); }
  if (url.hostname !== "127.0.0.1") refuse(`host is ${url.hostname}`);
  if (url.port === "" || url.port === "5432" || url.port === "5433") refuse(`port ${url.port || "<default>"} is a real cluster's port`);
  if (url.pathname !== "/throwaway") refuse(`database is ${url.pathname}, not /throwaway`);
  const marker = (await prisma.$queryRawUnsafe("select pgdata from _throwaway_pg_marker limit 1")) as Array<{ pgdata: string }>;
  const dataDir = (await prisma.$queryRawUnsafe("show data_directory")) as Array<{ data_directory: string }>;
  const m = marker[0]?.pgdata ?? "";
  const d = dataDir[0]?.data_directory ?? "";
  if (!m || m !== d || !/^\/tmp\/throwaway-pg-[^/]+\/pgdata$/.test(d)) refuse(`cluster proof failed (marker=${m} server=${d})`);
  return raw;
}

function execFile(url: string, file: string): { code: number | null; out: string } {
  const r = spawnSync("./node_modules/.bin/prisma", ["db", "execute", "--url", url, "--file", file], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

async function one<T>(sql: string): Promise<T> {
  const rows = (await prisma.$queryRawUnsafe(sql)) as T[];
  return rows[0] as T;
}

/** md5 of every table's ORIGINAL columns (ordered by id) + row counts + an md5 of the public catalog (columns, indexes, enum labels). */
async function snapshot(): Promise<{ data: Record<string, string>; counts: Record<string, number>; catalog: string }> {
  const data: Record<string, string> = {};
  const counts: Record<string, number> = {};
  for (const t of TABLES) {
    const r = await one<{ h: string | null; n: bigint }>(`select md5(coalesce(string_agg(row_to_json(x)::text, '|' order by x.id), '')) as h, count(*) as n from (select ${ORIGINAL[t]} from "${t}") x`);
    data[t] = r.h ?? "";
    counts[t] = Number(r.n);
  }
  const cat = await one<{ h: string }>(`select md5(
      coalesce((select string_agg(table_name||'.'||column_name||':'||data_type||':'||is_nullable, ',' order by table_name, column_name) from information_schema.columns where table_schema='public'), '') ||
      coalesce((select string_agg(indexname||'='||indexdef, ',' order by indexname) from pg_indexes where schemaname='public'), '') ||
      coalesce((select string_agg(t.typname||'.'||e.enumlabel, ',' order by t.typname, e.enumsortorder) from pg_enum e join pg_type t on t.oid=e.enumtypid), '')) as h`);
  return { data, counts, catalog: cat.h };
}

async function seed(dup: "none" | "address" | "delivery") {
  const q = (sql: string) => prisma.$executeRawUnsafe(sql);
  // the production inventory (2026-09-23): one platform client, two keys
  await q(`insert into clients (id, name, kind) values ('c_sp', 'SamaPrime', 'platform'), ('c_dh', 'dahabi', 'partner')`);
  await q(`insert into client_keys (id, client_id, name, key_prefix, key_hash, key_last4, scopes, issued_by, issued_via) values
    ('k_sp', 'c_sp', 'samaprime client', 'sk_live_2dhb', 'h1', 'sscg', array['addresses.write','deposits.read','withdrawals.write','withdrawals.read','balance.read'], 'ibrahim', 'cli'),
    ('k_adm', 'c_sp', 'samaprime admin', 'sk_live_klrq', 'h2', 's3yi', array['keys.issue'], 'ibrahim', 'cli'),
    ('k_dh', 'c_dh', 'dahabi', 'sk_live_dhab', 'h3', 'dh01', array['addresses.write','deposits.read','balance.read'], 'ibrahim', 'cli')`);
  // the index-1000000 address with its confirmed 3.01 and its exhausted delivery (fixture address, not the real one)
  await q(`insert into addresses (id, key_id, reference, chain, address, derivation_index) values
    ('a_idx1m', 'k_sp', 'samaprime:samacard:test:first-trc20-deposit', 'TRC20', 'TRehearsalIndex1000000xxxxxxxxxxxx', 1000000),
    ('a_legacy', 'k_sp', 'samaprime:m_samaprime:user:u_42', 'TRC20', 'TRehearsalLegacy57xxxxxxxxxxxxxxxx', 57),
    ('a_dh', 'k_dh', 'dahabi:shop:user:9', 'BEP20', '0xrehearsaldahabi000000000000000000000001', 1002),
    ('a_pi', 'k_sp', 'pi:store-intent-1', 'TRC20', 'TRehearsalIntent1001xxxxxxxxxxxxxx', 1001)`);
  await q(`update addresses set legacy_import = true where id = 'a_legacy'`);
  await q(`insert into deposits (id, key_id, address_id, chain, tx_hash, amount, confirmations, status, block_number, credited_at) values
    ('d_301', 'k_sp', 'a_idx1m', 'TRC20', 'rehearsal-tx-301', 3.01, 20, 'confirmed', 86022515, now() at time zone 'utc'),
    ('d_dh', 'k_dh', 'a_dh', 'BEP20', '0xrehearsal-dh-1', 5, 2, 'detected', 123508000, null)`);
  await q(`insert into webhook_deliveries (id, key_id, event_type, event_id, payload, attempts, status) values
    ('w_301', 'k_sp', 'deposit.confirmed', 'd_301', '{}'::jsonb, 8, 'exhausted'),
    ('w_dh', 'k_dh', 'deposit.confirmed', 'd_dh', '{}'::jsonb, 0, 'pending')`);
  await q(`insert into payment_intents (id, client_id, key_id, address_id, chain, amount, reference, expires_at, updated_at) values
    ('pi_1', 'c_sp', 'k_sp', 'a_pi', 'TRC20', 12.5, 'store-intent-1', (now() at time zone 'utc') + interval '1 hour', now() at time zone 'utc')`);
  if (dup === "address") {
    // same client (via ANOTHER key of it), same chain, same reference as a_legacy — legal before phase0
    await q(`insert into addresses (id, key_id, reference, chain, address, derivation_index) values ('a_dup', 'k_adm', 'samaprime:m_samaprime:user:u_42', 'TRC20', 'TRehearsalDuplicatexxxxxxxxxxxxxxx', 58)`);
  }
  if (dup === "delivery") {
    await q(`insert into webhook_deliveries (id, key_id, event_type, event_id, payload, status) values ('w_dup', 'k_sp', 'deposit.confirmed', 'd_301', '{}'::jsonb, 'exhausted')`);
  }
}

async function main() {
  const which = process.argv.find((a) => a.startsWith("--case="))?.slice(7);
  if (which !== "clean" && which !== "dup-address" && which !== "dup-delivery") refuse("usage: --case=clean|dup-address|dup-delivery");
  const url = await proveThrowaway();
  console.log(`[rehearsal] case=${which} on a proven throwaway cluster`);

  const dirs = readdirSync("prisma/migrations").filter((d) => /^\d{14}_/.test(d)).sort();
  const before = dirs.filter((d) => d < PHASE0);
  check(dirs.includes(PHASE0) && before.length === 4, `R0. the migrations before ${PHASE0} are the 4 already in the chain`, before.join(","));
  for (const d of before) {
    const r = execFile(url, `prisma/migrations/${d}/migration.sql`);
    if (r.code !== 0) { console.error(r.out); refuse(`applying ${d} failed (exit ${r.code})`); }
  }
  await seed(which === "clean" ? "none" : which === "dup-address" ? "address" : "delivery");
  const s0 = await snapshot();
  console.log(`[rehearsal] seeded: ${JSON.stringify(s0.counts)}`);

  const run = execFile(url, `prisma/migrations/${PHASE0}/migration.sql`);
  console.log(`[rehearsal] phase0 file exit ${run.code}\n${run.out.trim()}`);
  const s1 = await snapshot();

  if (which !== "clean") {
    const want = which === "dup-address" ? /phase0 pre-check: addresses has duplicate/ : /phase0 pre-check: webhook_deliveries has duplicate/;
    check(run.code !== 0 && want.test(run.out), `R1. the pre-check RAISES on the seeded duplicate (${which})`, `exit=${run.code}`);
    check(s1.catalog === s0.catalog, "R2. NOTHING changed in the catalog (columns, indexes, enum labels): md5 before = after", `${s0.catalog} → ${s1.catalog}`);
    check(TABLES.every((t) => s1.data[t] === s0.data[t] && s1.counts[t] === s0.counts[t]), "R3. NOTHING changed in any row: per-table md5 + count before = after", JSON.stringify(s1.counts));
    const cols = await one<{ n: bigint }>(`select count(*) as n from information_schema.columns where table_schema='public' and column_name in ('client_id') and table_name in ('addresses','deposits','webhook_deliveries')`);
    check(Number(cols.n) === 0, "R4. no client_id column was added (the migration did not half-apply)", `n=${cols.n}`);
  } else {
    check(run.code === 0, "R1. the phase0 file applies cleanly on production-shaped rows", `exit=${run.code}`);
    check(TABLES.every((t) => s1.data[t] === s0.data[t] && s1.counts[t] === s0.counts[t]), "R2. every pre-existing row keeps its original columns byte-identical (md5 per table)", JSON.stringify(s1.counts));
    const mism = await one<{ a: bigint; d: bigint; w: bigint; nulls: bigint }>(`select
        (select count(*) from addresses x join client_keys k on k.id = x.key_id where x.client_id is distinct from k.client_id) as a,
        (select count(*) from deposits x join client_keys k on k.id = x.key_id where x.client_id is distinct from k.client_id) as d,
        (select count(*) from webhook_deliveries x join client_keys k on k.id = x.key_id where x.client_id is distinct from k.client_id) as w,
        (select count(*) from addresses where client_id is null) + (select count(*) from deposits where client_id is null) + (select count(*) from webhook_deliveries where client_id is null) as nulls`);
    const pop = await one<{ n: bigint }>(`select (select count(*) from addresses) + (select count(*) from deposits) + (select count(*) from webhook_deliveries) as n`);
    check(Number(pop.n) === 8 && Number(mism.a) === 0 && Number(mism.d) === 0 && Number(mism.w) === 0 && Number(mism.nulls) === 0, "R3. backfill: every address/deposit/delivery client_id = its key's client, 0 NULL (over 8 rows)", JSON.stringify({ ...mism, pop: pop.n }, (_k, v) => (typeof v === "bigint" ? Number(v) : v)));
    const idx1m = await one<{ client_id: string; watch_disabled_at: Date | null }>(`select client_id, watch_disabled_at from addresses where id = 'a_idx1m'`);
    check(idx1m.client_id === "c_sp" && idx1m.watch_disabled_at === null, "R4. the index-1000000 row is owned by the SamaPrime client and not yet disabled (step 0 does that)", JSON.stringify(idx1m));
    const cl = await one<{ fee_bps: number; min_intent: string; max_intent: string; chains: string }>(`select fee_bps, min_intent::text, max_intent::text, array_to_string(enabled_chains, ',') as chains from clients where id = 'c_sp'`);
    const fee = await one<{ n: bigint }>(`select count(*) as n from deposits where fee_amount <> 0`);
    check(cl.fee_bps === 0 && cl.min_intent === "1.000000" && cl.max_intent === "10000.000000" && cl.chains === "BEP20,TRC20" && Number(fee.n) === 0, "R5. defaults: fee_bps 0, min 1, max 10000, both chains; every existing deposit fee_amount 0", JSON.stringify(cl));
    const idx = await one<{ n: bigint }>(`select count(*) as n from pg_indexes where schemaname='public' and indexname in ('addresses_client_id_chain_reference_key','webhook_deliveries_key_id_event_id_key','payment_intents_client_id_reference_key','events_object_id_type_key')`);
    const gone = await one<{ n: bigint }>(`select count(*) as n from pg_indexes where indexname = 'payment_intents_client_id_reference_idx'`);
    check(Number(idx.n) === 4 && Number(gone.n) === 0, "R6. the 4 UNIQUE indexes exist; the replaced plain index is gone", `unique=${idx.n} old=${gone.n}`);
    const dup = await prisma.$executeRawUnsafe(`insert into addresses (id, key_id, client_id, reference, chain, address, derivation_index) values ('a_dup2', 'k_adm', 'c_sp', 'samaprime:m_samaprime:user:u_42', 'TRC20', 'TRehearsalDup2xxxxxxxxxxxxxxxxxxxx', 59)`).then(() => "inserted", (e: Error) => (/unique/i.test(e.message) ? "unique_violation" : e.message));
    check(dup === "unique_violation", "R7. after phase0, a duplicate (client, chain, reference) is refused by the index", dup);
  }
  await prisma.$disconnect();
  process.exit(summary());
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
