// CONTRACT §9 STEP 5b — SamaPay takes over the legacy addresses at the exact
// block MNTAD's legacy scanner stopped at. Pasted as ONE line with step 5a:
//
//   <MNTAD> pnpm exec tsx scripts/ops/s2/stop-legacy-scanner.ts --apply --out=/path/cursors.json \
//     && <SamaPay> pnpm exec tsx scripts/ops/start-legacy-watch.ts --cursors=/path/cursors.json --apply
//
// THE CURSOR FILE (written by MNTAD's stop script, agent M3), EXACTLY:
//   {"TRC20": <int>, "BEP20": <int>, "stoppedAt": "<ISO-8601>"}
// Each number is MNTAD's final `last_scanned_block` for that chain — the last
// block it FULLY scanned. Any other key, a missing chain, a non-integer or a bad
// timestamp is refused before the database is read.
//
// WHAT IT SETS (contract v1.1 A2), per chain, in ONE transaction for both:
//   scan_cursors.last_scanned_block = MIN(SamaPay cursor, MNTAD final − depth)
//   scan_cursors.legacy_watch_enabled_at = now
// where depth = getChainConfig(chain).confirmationsRequired (the observer's own
// number). The cursor only moves BACK or stays; re-scanned blocks are absorbed
// by UNIQUE(chain, tx_hash). Rules and refusals: src/chain/cursor.ts header.
//
// DRY RUN BY DEFAULT: prints, per chain, MNTAD's block, SamaPay's cursor, the
// target, how many blocks will be re-scanned and how many legacy addresses
// become watched. Writes nothing without --apply.
//
// RE-RUNNABLE (A2/H8): a chain already stamped is left untouched, so the saved
// file can be pasted again safely.
import { readFileSync } from "node:fs";
import { prisma } from "@/db/client.js";
import logger from "@/log.js";
import { appendAudit } from "@/audit/append.js";
import { getChainConfig, getCryptoNetworkMode } from "@/chain/impl/config.js";
import { CHAINS, LegacyWatchRefused, lockCursor, parseCursorFile, planChain, setCursorAndEnableLegacyWatch, type ChainPlan } from "@/chain/cursor.js";

const log = logger.child({ mod: "ops/start-legacy-watch" });

function flag(name: string): string | undefined {
  const pre = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pre));
  return hit?.slice(pre.length);
}

class DryRunRollback extends Error {}

async function main(): Promise<number> {
  const file = flag("cursors");
  const apply = process.argv.includes("--apply");
  const by = flag("by") ?? "ibrahim";
  if (!file) { console.error("usage: tsx scripts/ops/start-legacy-watch.ts --cursors=<file> [--apply] [--by=<who>]"); return 2; }

  const cursors = parseCursorFile(readFileSync(file, "utf8"));
  console.log(`cursor file: TRC20 ${cursors.TRC20}, BEP20 ${cursors.BEP20}, MNTAD stopped at ${cursors.stoppedAt}`);
  console.log(apply ? "MODE: APPLY" : "MODE: DRY RUN (nothing is written; pass --apply)");

  // The observer's own depth per chain; printed so the operator reads it before --apply.
  const depth = Object.fromEntries(CHAINS.map((c) => [c, BigInt(getChainConfig(c).confirmationsRequired)])) as Record<(typeof CHAINS)[number], bigint>;
  console.log(`network: ${getCryptoNetworkMode()}; confirmation depth TRC20 ${depth.TRC20}, BEP20 ${depth.BEP20}`);

  const at = new Date();
  let plans: ChainPlan[] = [];
  try {
    await prisma.$transaction(async (tx) => {
      // Locks in a fixed order (TRC20, BEP20) so two runs cannot deadlock.
      for (const chain of CHAINS) await lockCursor(tx, chain);
      plans = [];
      for (const chain of CHAINS) plans.push(await planChain(tx, chain, BigInt(cursors[chain]), depth[chain]));
      if (!apply) throw new DryRunRollback();
      for (const p of plans) {
        if (p.alreadyEnabledAt) continue;
        await setCursorAndEnableLegacyWatch(tx, p, at);
        await appendAudit(tx, {
          actor: `admin:${by}`, action: "legacy_watch.started", subjectId: p.chain,
          params: { chain: p.chain, mntadFinal: p.mntadFinal.toString(), from: p.current?.toString() ?? null, to: p.target.toString(), rescan: p.rescan.toString(), legacyAddresses: p.legacyAddresses, mntadStoppedAt: cursors.stoppedAt },
        });
      }
    }, { timeout: 30_000 });
  } catch (e) {
    if (!(e instanceof DryRunRollback)) throw e;
  }

  for (const p of plans) {
    if (p.alreadyEnabledAt) { console.log(`${p.chain}: ALREADY ENABLED at ${p.alreadyEnabledAt.toISOString()} — no change (cursor ${p.current})`); continue; }
    console.log(`${p.chain}: ${apply ? "SET" : "WOULD SET"} cursor ${p.current ?? "<none>"} -> ${p.target}; re-scan ${p.rescan} block(s) (MNTAD final ${p.mntadFinal}); ${p.legacyAddresses} legacy address(es) watched`);
  }
  log.info({ actor: by, action: "legacy_watch.start", result: apply ? "applied" : "dry_run", plans: plans.map((p) => ({ chain: p.chain, from: p.current?.toString() ?? null, to: p.target.toString(), alreadyEnabled: p.alreadyEnabledAt !== null })) }, "start-legacy-watch");
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e) => {
    const refused = e instanceof LegacyWatchRefused;
    console.error(`${refused ? "REFUSED" : "FAILED"}: ${e instanceof Error ? e.message : String(e)} — nothing was written`);
    log.error({ action: "legacy_watch.start", result: refused ? "refused" : "error", err: e instanceof Error ? e.message : String(e) }, "start-legacy-watch");
    process.exitCode = refused ? 3 : 1;
  })
  .finally(() => prisma.$disconnect());
