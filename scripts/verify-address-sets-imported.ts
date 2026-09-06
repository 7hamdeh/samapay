// COVERS: docs/seed-move-plan-2026-09-06.md
//
// ⚠️ POST-CUT ONLY. The mirror of verify-address-sets-disjoint.ts, and a
// SEPARATE FILE on Ibrahim's instruction (#30):
//
//   "write the second one, and make the first REFUSE to run after the import.
//    A script that quietly changes what it means is the failure we spent last
//    night naming."
//
// Before the cut the two systems must watch DIFFERENT addresses. After it,
// SamaPay has imported all 194 and they are IDENTICAL BY DESIGN — so the
// earlier script's "disjoint" verdict becomes the FAILURE condition, and a
// failed or partial import produces precisely that verdict. Two files cannot
// be confused by a typo; one file with a switch can.
//
// Read-only against both databases.
import { PrismaClient } from "@prisma/client";

const SAMAPRIME_URL = process.env.SAMAPRIME_DATABASE_URL;

let pass = 0, fail = 0, voidCount = 0;
function check(ok: boolean, label: string, detail: string) {
  if (ok) { pass++; console.log(`[PASS] ${label} — ${detail}`); }
  else { fail++; console.log(`[FAIL] ${label} — ${detail}`); }
}
function markVoid(label: string, detail: string) { voidCount++; console.log(`[VOID] ${label} — ${detail}`); }

async function main() {
  if (!SAMAPRIME_URL) {
    markVoid("cannot compare", "SAMAPRIME_DATABASE_URL is not set — nothing was compared. INCONCLUSIVE, not a pass.");
    process.exit(2);
  }
  const pay = new PrismaClient();
  const prime = new PrismaClient({ datasources: { db: { url: SAMAPRIME_URL } } });

  // THE MIRROR REFUSAL. If the import has not happened, this script's claim is
  // not the right one and it must not run — the same rule, pointing the other
  // way, so neither script can ever be the one quietly answering.
  const legacy = await pay.address.count({ where: { legacyImport: true } });
  if (legacy === 0) {
    console.error("REFUSING: SamaPay holds no legacyImport addresses — the import has NOT happened.");
    console.error("Before the cut the correct assertion is DISJOINT. Run verify-address-sets-disjoint.ts instead.");
    await pay.$disconnect(); await prime.$disconnect();
    process.exit(1);
  }

  const primeRows = (await prime.$queryRawUnsafe("select address, chain::text as chain from crypto_addresses")) as Array<{ address: string; chain: string }>;
  const payRows = await pay.address.findMany({ select: { address: true, chain: true } });
  console.log(`  SamaPrime addresses: ${primeRows.length}`);
  console.log(`  SamaPay addresses:   ${payRows.length} (${legacy} imported)\n`);

  if (primeRows.length === 0) {
    markVoid("SamaPrime side is empty", "read 0 rows — the URL points at the wrong database or the probe is broken; nothing was compared");
  }

  const paySet = new Set(payRows.map((r) => `${r.chain}:${r.address.toLowerCase()}`));
  const missing = primeRows.filter((r) => !paySet.has(`${r.chain}:${r.address.toLowerCase()}`));

  // THE CLAIM: every legacy address is watched by SamaPay. A missing one is an
  // address whose owner can still deposit and whose deposit nobody will see.
  check(primeRows.length > 0 && missing.length === 0,
    "EVERY SamaPrime address is present in SamaPay",
    `${primeRows.length - missing.length} of ${primeRows.length} imported${missing.length ? `, MISSING ${missing.length}: ${missing.slice(0, 3).map((m) => m.chain + " " + m.address).join(", ")}${missing.length > 3 ? " …" : ""}` : ""}`);

  // CONTROLS — the comparison must be able to say both yes and no.
  const known = primeRows[0];
  if (!known) markVoid("control: planted match", "no SamaPrime row to plant from");
  else {
    check(paySet.has(`${known.chain}:${known.address.toLowerCase()}`), "control: the comparison FINDS a known address", `${known.chain} ${known.address}`);
    check(!paySet.has("BEP20:0xzzq-not-an-address"), "control: the comparison rejects a non-member", "probe can say no");
  }

  // ⚠️ AND THE CLAIM THIS SCRIPT CANNOT MAKE, STATED SO ITS SILENCE IS NOT READ
  // AS ASSENT. "SamaPrime's scanner is stopped" is a PROCESS fact, not a
  // database fact, and if it is still running BOTH systems credit every legacy
  // deposit — which is the exact double-credit this whole family exists to
  // prevent, arriving from the other side.
  markVoid("SamaPrime's scanner is STOPPED", "a process fact, not a database fact — it needs its own instrument and is NOT proven here");

  console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${voidCount} VOID`);
  if (voidCount > 0) console.log("INCONCLUSIVE ON AT LEAST ONE CLAIM — read the VOID lines.");
  await pay.$disconnect(); await prime.$disconnect();
  if (pass === 0) { console.log("VOID — nothing executed"); process.exit(1); }
  process.exit(fail === 0 ? (voidCount > 0 ? 2 : 0) : 1);
}
main();
