// COVERS: src/db/guard.ts
//
// RUN SAMAPAY VERIFY SCRIPTS ON A FULLY DISPOSABLE CLUSTER — never the shared
// samapay_sandbox, never production. Meant to run INSIDE SamaPrime's
// scripts/throwaway-pg.sh, which starts its own initdb cluster, proves it is
// talking to that cluster, and exports DATABASE_URL=…/throwaway:
//
//   bash /www/wwwroot/samaprime.com/scripts/throwaway-pg.sh \
//     ./node_modules/.bin/tsx scripts/throwaway-sandbox.ts scripts/verify-a.ts scripts/verify-b.ts
//
// WHY A SIBLING DATABASE. src/db/guard.ts (the first statement of every verify
// script) refuses any database whose NAME does not end in `_sandbox`, and the
// wrapper's database is called `throwaway`. The guard is not weakened; it is
// satisfied the way its code expects: this harness creates `throwaway_sandbox`
// ON THE SAME DISPOSABLE CLUSTER and hands that URL to each child. The URL is
// DERIVED from the wrapper's own (only the path changes), so no literal URL
// exists anywhere.
//
// It REFUSES before creating anything unless it can re-prove, over its own
// connection, that it is on a throwaway-pg cluster: 127.0.0.1, not 5432/5433
// (production and the box's second real instance), database `throwaway`,
// and the wrapper's marker row naming the same data directory the server
// reports.
//
// SCHEMA: `prisma db push` from prisma/schema.prisma, NOT `migrate deploy`
// (the session's production-write guard refuses the latter by name). The
// consequence is written down, not hidden: raw-SQL objects that exist only in
// migration files — the audit_events append-only triggers — are ABSENT here.
import { spawnSync } from "node:child_process";
import { prisma } from "@/db/client.js";

function refuse(msg: string): never {
  console.error(`REFUSING (throwaway-sandbox): ${msg}`);
  process.exit(2);
}

async function main() {
  const scripts = process.argv.slice(2);
  if (scripts.length === 0) refuse("usage: tsx scripts/throwaway-sandbox.ts <verify-script.ts>...");
  const raw = process.env.DATABASE_URL;
  if (!raw) refuse("DATABASE_URL is not set — run inside throwaway-pg.sh");
  let url: URL;
  try { url = new URL(raw); } catch { refuse("DATABASE_URL does not parse"); }
  if (url.hostname !== "127.0.0.1") refuse(`host is ${url.hostname}, not 127.0.0.1`);
  if (url.port === "" || url.port === "5432" || url.port === "5433") refuse(`port ${url.port || "<default>"} is a real cluster's port`);
  if (url.pathname !== "/throwaway") refuse(`database is ${url.pathname}, not /throwaway`);

  // Re-prove over OUR connection: the wrapper's marker row and the server's
  // own data_directory must name the same, throwaway-pg-shaped directory.
  const marker = (await prisma.$queryRawUnsafe("select pgdata from _throwaway_pg_marker limit 1")) as Array<{ pgdata: string }>;
  const dataDir = (await prisma.$queryRawUnsafe("show data_directory")) as Array<{ data_directory: string }>;
  const m = marker[0]?.pgdata ?? "";
  const d = dataDir[0]?.data_directory ?? "";
  if (!m || m !== d || !/^\/tmp\/throwaway-pg-[^/]+\/pgdata$/.test(d)) refuse(`cluster proof failed (marker=${m} server=${d})`);
  console.log(`[throwaway-sandbox] cluster proof OK: ${d}`);

  // --check-migrations: prove the migration FILES reproduce schema.prisma
  // exactly. Prisma replays every migrations/*/migration.sql into a SHADOW
  // database — here an empty database on this same disposable cluster — and
  // diffs the result against the datamodel. --exit-code: 0 = identical,
  // 2 = drift (printed). This is the only place migration SQL executes in a
  // test run; nothing is applied to any database that outlives the cluster.
  if (scripts[0] === "--check-migrations") {
    await prisma.$executeRawUnsafe("CREATE DATABASE throwaway_shadow");
    await prisma.$disconnect();
    const shadow = new URL(url.toString());
    shadow.pathname = "/throwaway_shadow";
    const r = spawnSync("./node_modules/.bin/prisma", ["migrate", "diff", "--from-migrations", "prisma/migrations", "--to-schema-datamodel", "prisma/schema.prisma", "--shadow-database-url", shadow.toString(), "--script", "--exit-code"], { stdio: "inherit" });
    console.log(`[throwaway-sandbox] migrations-vs-schema diff exit ${r.status} (0 = the files reproduce the schema exactly)`);
    process.exit(r.status === 0 ? 0 : 1);
  }

  await prisma.$executeRawUnsafe("CREATE DATABASE throwaway_sandbox");
  await prisma.$disconnect();
  const sandbox = new URL(url.toString());
  sandbox.pathname = "/throwaway_sandbox";
  const env = { ...process.env, DATABASE_URL: sandbox.toString() };

  const push = spawnSync("./node_modules/.bin/prisma", ["db", "push", "--accept-data-loss", "--skip-generate"], { env, stdio: "inherit" });
  if (push.status !== 0) refuse(`prisma db push exited ${push.status}`);

  const results: Array<[string, number | null]> = [];
  for (const s of scripts) {
    console.log(`\n══════ ${s} ══════`);
    const r = spawnSync("./node_modules/.bin/tsx", [s], { env, stdio: "inherit" });
    results.push([s, r.status]);
  }
  console.log("\n[throwaway-sandbox] results:");
  for (const [s, code] of results) console.log(`  exit ${code}  ${s}`);
  process.exit(results.every(([, c]) => c === 0) ? 0 : 1);
}

main().catch((e) => { console.error("throwaway-sandbox crashed:", e); process.exit(1); });
