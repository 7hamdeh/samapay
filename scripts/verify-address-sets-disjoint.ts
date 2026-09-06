// COVERS: src/chain/live.ts docs/cut-window-amendment-c-2026-09-06.md
//
// ⚠️ THE ASSERTION RULING (ج) CREATED THE NEED FOR.
//
// Under (ج) SamaPrime and SamaPay watch the SAME TWO BLOCKCHAINS AT THE SAME
// TIME, permanently — SamaPrime its 194 legacy addresses, SamaPay every new
// one. My cut-window plan called two scanners on one chain "the one thing that
// must never overlap"; that is now a permanent condition rather than a
// forbidden one, and it is safe IFF the two address sets are disjoint.
//
// Today that is true BY CRYPTOGRAPHY AND BY NOTHING CHECKED: different seeds
// produce different addresses. That is an argument, not an instrument.
//
// ⚠️ THE FAILURE IF IT IS EVER VIOLATED: one on-chain transfer is observed by
// BOTH systems and credited TWICE, into two different balances, with each
// system's own idempotency guard perfectly satisfied — because neither can see
// the other's rows. Nothing in either system can detect it alone.
//
// Read-only against both databases. Nothing is written anywhere.
import { PrismaClient as PayClient } from "@prisma/client";

const SAMAPRIME_URL = process.env.SAMAPRIME_DATABASE_URL;

// ⚠️⚠️ THIS SCRIPT IS PRE-CUT ONLY AND REFUSES TO RUN AFTER THE IMPORT.
//
// Its claim inverts at the cutover:
//   PRE-CUT   the two systems watch DIFFERENT addresses. Overlap means one
//             deposit credited TWICE, in two systems, with each one's
//             UNIQUE(chain, tx_hash) perfectly satisfied because neither can
//             see the other's rows.          ⇒ assert DISJOINT.
//   POST-CUT  SamaPay has imported the 194. The sets are IDENTICAL BY DESIGN
//             and "disjoint" becomes the FAILURE condition — a failed or
//             partial import produces exactly the result this script calls a
//             PASS.                          ⇒ a DIFFERENT script's job.
//
// Ibrahim, #30: "write the second one, and make the first REFUSE to run after
// the import. A script that quietly changes what it means is the failure we
// spent last night naming."
//
// It is not gated on an argument. An argument is one typo away from asserting
// the opposite; the refusal is derived from the DATA — the presence of any
// legacyImport address means the import has happened and this script's claim
// is no longer the right one. See scripts/verify-address-sets-imported.ts.

let pass = 0, fail = 0, voidCount = 0;
function check(ok: boolean, label: string, detail: string) {
  if (ok) { pass++; console.log(`[PASS] ${label} — ${detail}`); }
  else { fail++; console.log(`[FAIL] ${label} — ${detail}`); }
}
function markVoid(label: string, detail: string) { voidCount++; console.log(`[VOID] ${label} — ${detail}`); }

async function main() {
  if (!SAMAPRIME_URL) {
    markVoid("cannot compare", "SAMAPRIME_DATABASE_URL is not set — the comparison did NOT run. This is INCONCLUSIVE, not a pass.");
    console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${voidCount} VOID`);
    console.log("INCONCLUSIVE — a VOID here means the two sets were never compared.");
    process.exit(2);
  }

  const pay = new PayClient();
  const prime = new PayClient({ datasources: { db: { url: SAMAPRIME_URL } } });

  // THE REFUSAL. Derived from the data, not from a flag.
  const legacy = await pay.address.count({ where: { legacyImport: true } });
  if (legacy > 0) {
    console.error(`REFUSING: SamaPay holds ${legacy} legacyImport address(es) — the import has happened.`);
    console.error("After the cut the two sets are IDENTICAL BY DESIGN and 'disjoint' is the FAILURE condition.");
    console.error("This script would pass for exactly the wrong reason. Run verify-address-sets-imported.ts instead.");
    await pay.$disconnect(); await prime.$disconnect();
    process.exit(1);
  }

  const payRows = await pay.address.findMany({ select: { address: true, chain: true } });
  const primeRows = (await prime.$queryRawUnsafe(
    "select address, chain::text as chain from crypto_addresses",
  )) as Array<{ address: string; chain: string }>;

  // POPULATION FIRST. An emptiness claim over an empty set is a true statement
  // about nothing — and "no overlap" is exactly that shape.
  console.log(`  SamaPay addresses:   ${payRows.length}`);
  console.log(`  SamaPrime addresses: ${primeRows.length}`);

  if (primeRows.length === 0) {
    markVoid("SamaPrime side is empty", "read 0 rows — either the URL points at the wrong database or the probe is broken; either way nothing was compared");
  }

  const primeSet = new Set(primeRows.map((r) => `${r.chain}:${r.address.toLowerCase()}`));
  const overlap = payRows.filter((r) => primeSet.has(`${r.chain}:${r.address.toLowerCase()}`));

  if (payRows.length === 0) {
    markVoid("SamaPay side is empty", `0 addresses issued yet — disjointness is VACUOUSLY true and proves nothing. Re-run once SamaPay has issued at least one.`);
  } else {
    check(overlap.length === 0, "the two address sets are DISJOINT", `${payRows.length} vs ${primeRows.length}, overlap ${overlap.length}`);
  }

  // ⚠️ THE CONTROL THAT MAKES THE ABOVE MEAN ANYTHING: plant a known match and
  // require the comparison to FIND it. Without this, a broken key format or a
  // case mismatch reports "disjoint" for a set that fully overlaps.
  const planted = primeRows[0];
  if (!planted) {
    markVoid("control: planted match", "no SamaPrime row to plant from");
  } else {
    const key = `${planted.chain}:${planted.address.toLowerCase()}`;
    check(primeSet.has(key), "control: the comparison FINDS a known match", `planted ${planted.chain} address is detected — a 'disjoint' verdict can be trusted`);
    check(!primeSet.has("BEP20:0xzzq-not-an-address"), "control: the comparison rejects a non-member", "probe can say no");
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${voidCount} VOID`);
  if (voidCount > 0 && fail === 0) { console.log("INCONCLUSIVE — read the VOID lines; they say what was NOT compared."); }
  await pay.$disconnect(); await prime.$disconnect();
  if (pass === 0) { console.log("VOID — nothing executed"); process.exit(1); }
  process.exit(fail === 0 ? (voidCount > 0 ? 2 : 0) : 1);
}
main();
