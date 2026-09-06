// COVERS: src/chain/live.ts src/worker/index.ts
//
// ⚠️ "RUNNING" IS NOT "DOING ITS JOB" — Ibrahim, 2026-09-07.
// pm2 reported samapay-worker "online, 0 restarts" while it observed NOTHING,
// because nothing called the observer. No status line anywhere said so. This is
// the witness for the WORK rather than the PROCESS.
//
// ⚠️⚠️ AND IT REPORTS THE BLOCK AND THE AGE TOGETHER, DELIBERATELY.
// An age alone lies: `scan_cursors.updated_at` is `timestamp WITHOUT time zone`
// and this server runs Europe/Berlin, so a naive `now() - updated_at` reads
// 7230s against a true 30s. design-5-4d nearly reported SamaPrime's live
// scanner dead on exactly that, and this repository had already paid for the
// same artefact once before in a different table.
//
// ⇒ A CURSOR THAT ADVANCES WHILE ITS AGE CLIMBS IS SELF-CONTRADICTING, AND THE
//   CONTRADICTION IS THE INSTRUMENT. Both times it was a contradiction that
//   caught this, not care.
//
// ⚠️ AND A ROUND-NUMBERED GAP — 3600, 7200, 86400 — IS A TIMEZONE HYPOTHESIS
//   BEFORE IT IS AN OUTAGE REPORT. Faults do not produce suspiciously round
//   numbers. This script says so out loud when it sees one.
import { prisma } from "@/db/client.js";

const STALE_AFTER_S = 3600; // his rule: scanned nothing in an hour = RED

type Row = { chain: string; blk: string; utc_age: number; naive_age: number; updated: Date };

async function read(): Promise<Row[]> {
  return (await prisma.$queryRawUnsafe(`
    select chain::text as chain,
           last_scanned_block::text as blk,
           extract(epoch from (now() at time zone 'UTC' - updated_at))::int as utc_age,
           extract(epoch from (now() - updated_at))::int as naive_age,
           updated_at as updated
      from scan_cursors order by chain`)) as Row[];
}

async function main() {
  const a = await read();
  if (a.length === 0) {
    console.log("[VOID] no scan_cursors rows — the observer has never completed a pass. Nothing was measured.");
    process.exit(2);
  }
  console.log("  waiting 20s to see whether the block MOVES…\n");
  await new Promise((r) => setTimeout(r, 20_000));
  const b = await read();

  let red = 0;
  for (const now of b) {
    const before = a.find((x) => x.chain === now.chain);
    const advanced = before ? BigInt(now.blk) > BigInt(before.blk) : false;
    const drift = now.naive_age - now.utc_age;
    const roundDrift = [3600, 7200, 10800, 86400].includes(Math.abs(drift));

    console.log(`  ${now.chain}`);
    console.log(`    block            ${before?.blk ?? "?"} -> ${now.blk}   ${advanced ? "✅ ADVANCING" : "⚠️ unchanged in 20s"}`);
    console.log(`    age (TRUE, UTC)  ${now.utc_age}s   ${now.utc_age > STALE_AFTER_S ? "🔴 STALE" : "✅ fresh"}`);
    console.log(`    age (naive)      ${now.naive_age}s${roundDrift ? `   ⚠️ differs by exactly ${drift}s — TIMEZONE ARTEFACT, not an outage` : ""}`);

    // THE CONTRADICTION CHECK. These two cannot both be true.
    if (advanced && now.utc_age > STALE_AFTER_S) {
      console.log(`    🔴 CONTRADICTION: the block advanced while the age says stale.`);
      console.log(`       One of the two is lying and it is almost certainly the CLOCK, not the worker.`);
      red++;
    } else if (!advanced && now.utc_age > STALE_AFTER_S) {
      console.log(`    🔴 RED: not advancing AND stale. The observer is not doing its job.`);
      red++;
    }
    const gaps = (await prisma.$queryRawUnsafe(
      `select count(*)::int n from scan_gaps where chain = '${now.chain}'::"Chain" and closed_at is null`)) as Array<{ n: number }>;
    console.log(`    open scan gaps   ${gaps[0]!.n}${gaps[0]!.n ? "   ⚠️ ranges the observer did NOT scan and has not re-covered" : ""}`);
    console.log("");
  }
  await prisma.$disconnect();
  process.exit(red === 0 ? 0 : 1);
}
main();
