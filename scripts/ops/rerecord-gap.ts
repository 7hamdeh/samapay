// RE-RECORD ONE QUARANTINED TRANSFER — the manual path for a scan_gaps row
// with reason `poison_transfer` (src/observer/index.ts). Run AFTER a human
// fixed what made the transfer unrecordable.
//
//   DRY RUN (default, writes nothing):
//     pnpm exec tsx --env-file=.env scripts/ops/rerecord-gap.ts --gap=<scan_gaps id>
//   APPLY (Ibrahim's keystroke, after a fresh SamaPay backup):
//     … --gap=<id> --apply --backup=/root/backups/samapay/samapay-<stamp>.dump.gpg
//   REHEARSAL (throwaway *_sandbox only): … --rehearsal [--apply --backup=<fixture>]
//
// What it does: re-scans the gap's block range ON-CHAIN for the tx named in the
// gap's evidence, at that address; records it through the observer (the only
// writer of `deposits`); closes the gap ONLY once the deposit row exists. The
// amount is always re-read from the chain — the evidence is a pointer, never a
// source of money. Idempotent: a closed gap is reported and left alone; a tx
// already recorded closes the gap without a second row (UNIQUE(chain, tx_hash)).
//
// Gate: G4's src/chain/seed/ops-gate.ts — production (samapay on 5432) or
// `--rehearsal` on a throwaway sandbox; --apply requires a fresh verified dump.
// exit 0 = done / would do / already done · 1 = REFUSED · 3 = FAILED.
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { prisma } from "@/db/client.js";
import { backupDirFor, openOpsRun, OpsRefused, parseOpsArgs, requireFreshBackup } from "@/chain/seed/ops-gate.js";
import { rerecordGap } from "@/observer/index.js";

const GapId = z.string().regex(/^[a-z0-9]{10,40}$/, "a scan_gaps id (cuid)");

export async function main(argv: readonly string[]): Promise<number> {
  try {
    const mode = parseOpsArgs(argv, ["--gap"]);
    const gap = GapId.safeParse(mode.values.get("--gap"));
    if (!gap.success) throw new OpsRefused("--gap=<scan_gaps id> is required (a cuid)");
    await openOpsRun("scripts/ops/rerecord-gap.ts", mode);
    if (mode.apply) await requireFreshBackup(mode.values.get("--backup"), backupDirFor(mode));
    const out = await rerecordGap(gap.data, { apply: mode.apply, actor: `ops:rerecord-gap${mode.rehearsal ? ":rehearsal" : ""}` });
    console.log(JSON.stringify(out));
    switch (out.outcome) {
      case "would_record": console.log("\nDRY RUN — nothing written. Re-run with --apply --backup=<fresh dump>."); return 0;
      case "recorded": case "already_known": console.log(`\n${out.outcome}: deposit ${out.depositId}; gap ${out.gapClosed ? "CLOSED" : "was already closed"}.`); return 0;
      case "already_closed": console.log("\nthe gap is already closed — nothing to do."); return 0;
      default: console.error(`\nREFUSED: ${out.outcome} — the gap stays OPEN.`); return 1;
    }
  } catch (e) {
    if (e instanceof OpsRefused) { console.error(`REFUSED: ${e.message}`); return 1; }
    console.error(`FAILED: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    return 3;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then(async (code) => { await prisma.$disconnect(); process.exit(code); });
}
