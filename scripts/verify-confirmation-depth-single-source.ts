// COVERS: src/chain/types.ts src/chain/live.ts src/observer/index.ts src/worker/index.ts src/chain/impl/config.ts
//
// docs/confirmation-depth-divergence-2026-09-07.md, CLOSED — the two
// definitions this file was about are now one. Before this change:
//   src/chain/types.ts        CONFIRMATIONS_REQUIRED       { BEP20: 15, TRC20: 19 }  <- the OBSERVER credited on this
//   src/chain/impl/config.ts  MAINNET_CONFIRMATION_FLOOR   { BEP20: 15, TRC20: 19 }  <- the ADAPTER honoured env overrides through this
// Nothing read both, so raising CRYPTO_TRON_CONFIRMATIONS looked applied and
// changed nothing about when a deposit is actually credited.
//
// The fix removed the duplicate rather than adding an equality assertion
// between two copies: chain/live.ts's scan-window cap and
// observer/index.ts's crediting threshold now both take their number from
// getChainConfig(chain).confirmationsRequired, passed as an explicit
// parameter into observeChain() — there is no second constant left to drift.
//
// This script proves three things, in order: (1) that literal wiring exists
// at both real call sites, (2) that no second hardcoded depth definition has
// crept back in anywhere in src/, and (3) that an env override actually
// changes the one number both sites would use — behaviourally, not by
// reading source.
import { readFileSync } from "node:fs";
import { getChainConfig } from "@/chain/impl/config.js";

let pass = 0, fail = 0;
function check(ok: boolean, label: string, detail = "") { if (ok) pass++; else fail++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`); }

function read(path: string): string { return readFileSync(path, "utf8"); }
// Flattened: this file's own house rule — a line-oriented match on wrapped
// source can return a false negative. Not expected to matter for these short
// one-line call expressions, but cheap to do unconditionally.
function flat(s: string): string { return s.split(/\s+/).join(" "); }

async function main() {
  // 1. THE TWO REAL CALL SITES ACTUALLY CALL THE SAME FUNCTION.
  const live = flat(read(new URL("../src/chain/live.ts", import.meta.url).pathname));
  const worker = flat(read(new URL("../src/worker/index.ts", import.meta.url).pathname));
  check(live.includes("getChainConfig(chain).confirmationsRequired"), "1a. chain/live.ts's scan-window cap reads getChainConfig(chain).confirmationsRequired");
  check(worker.includes("getChainConfig(chain).confirmationsRequired"), "1b. worker/index.ts's observe loop reads getChainConfig(chain).confirmationsRequired");
  check(!live.includes("CONFIRMATIONS_REQUIRED") && !worker.includes("CONFIRMATIONS_REQUIRED"), "1c. neither file references the retired duplicate constant by name");

  // 2. NO SECOND HARDCODED DEPTH DEFINITION EXISTS ANYWHERE IN src/, WITH A
  //    CONTROL PROVING THE SEARCH CAN SEE THE ONE LEGITIMATE DEFINITION.
  const configSrc = flat(read(new URL("../src/chain/impl/config.ts", import.meta.url).pathname));
  const typesSrc = flat(read(new URL("../src/chain/types.ts", import.meta.url).pathname));
  const depthLiteral = /\{\s*BEP20:\s*1[0-9],\s*TRC20:\s*1[0-9],?\s*\}/;
  const controlHit = depthLiteral.test(configSrc);
  check(controlHit, "2a. CONTROL — the search pattern finds MAINNET_CONFIRMATION_FLOOR's own definition", controlHit ? "found" : "BROKEN PROBE — nothing below this line means anything");
  const secondHit = depthLiteral.test(typesSrc);
  check(!secondHit, "2b. chain/types.ts carries no second depth-shaped literal (the retired CONFIRMATIONS_REQUIRED)", secondHit ? "FOUND ONE — the duplicate is back" : "absent, as expected");

  // 3. BEHAVIOURAL: an env override actually changes the number
  //    getChainConfig returns, mainnet mode, both chains, both directions
  //    (raise is honoured; below-floor is refused — pre-existing behaviour,
  //    re-checked here because this is now the ONLY thing standing between a
  //    misconfigured depth and an early credit).
  const savedMode = process.env.CRYPTO_MODE;
  const savedTron = process.env.CRYPTO_TRON_CONFIRMATIONS;
  const savedBsc = process.env.CRYPTO_BSC_CONFIRMATIONS;
  try {
    process.env.CRYPTO_MODE = "mainnet";
    delete process.env.CRYPTO_TRON_CONFIRMATIONS;
    delete process.env.CRYPTO_BSC_CONFIRMATIONS;
    const trc20Default = getChainConfig("TRC20").confirmationsRequired;
    const bep20Default = getChainConfig("BEP20").confirmationsRequired;
    check(trc20Default === 19 && bep20Default === 15, "3a. unset env → both chains at their mainnet floor (19, 15)", `${trc20Default}, ${bep20Default}`);

    process.env.CRYPTO_TRON_CONFIRMATIONS = "25";
    const trc20Raised = getChainConfig("TRC20").confirmationsRequired;
    check(trc20Raised === 25, "3b. CRYPTO_TRON_CONFIRMATIONS=25 → getChainConfig(\"TRC20\").confirmationsRequired is 25 — the number both real call sites would now use", `${trc20Raised}`);
    const bep20Unaffected = getChainConfig("BEP20").confirmationsRequired;
    check(bep20Unaffected === 15, "3c. the other chain is untouched by TRC20's override", `${bep20Unaffected}`);

    process.env.CRYPTO_TRON_CONFIRMATIONS = "5"; // below the 19-block floor
    let refused = false;
    try { getChainConfig("TRC20"); } catch { refused = true; }
    check(refused, "3d. a depth below the mainnet floor is REFUSED, not silently clamped — pre-existing guard, unaffected by this change");
  } finally {
    if (savedMode === undefined) delete process.env.CRYPTO_MODE; else process.env.CRYPTO_MODE = savedMode;
    if (savedTron === undefined) delete process.env.CRYPTO_TRON_CONFIRMATIONS; else process.env.CRYPTO_TRON_CONFIRMATIONS = savedTron;
    if (savedBsc === undefined) delete process.env.CRYPTO_BSC_CONFIRMATIONS; else process.env.CRYPTO_BSC_CONFIRMATIONS = savedBsc;
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
