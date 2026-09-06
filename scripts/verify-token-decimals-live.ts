// COVERS: src/chain/live.ts src/chain/impl/config.ts
//
// THE ONE NUMBER THAT MIS-PRICES BY A TRILLION, CHECKED AGAINST THE CHAIN.
//
// BEP20 USDT has 18 decimals. TRC20 USDT has 6. Hardcoding one for both
// mis-prices every deposit by 1e12 — SamaPrime's documented worst crypto
// defect class. Our configured value is one instrument; the CONTRACT'S OWN
// decimals() is a second, independent one that cannot share a bug with it.
//
// Read-only. Two mainnet eth_call / triggerConstantContract requests. No key,
// no money, nothing written.
import { ethers } from "ethers";

const BSC_RPC = process.env.CRYPTO_BSC_MAINNET_RPC ?? "https://bsc-dataseed.binance.org";
const BSC_USDT = process.env.CRYPTO_BSC_MAINNET_USDT_CONTRACT ?? "0x55d398326f99059fF775485246999027B3197955";
const TRON_RPC = process.env.CRYPTO_TRON_MAINNET_RPC ?? "https://api.trongrid.io";
const TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

const EXPECTED = { BEP20: 18, TRC20: 6 } as const;

let pass = 0, fail = 0, voidCount = 0;
function check(ok: boolean, label: string, detail: string) {
  if (ok) { pass++; console.log(`[PASS] ${label} — ${detail}`); }
  else { fail++; console.log(`[FAIL] ${label} — ${detail}`); }
}
function markVoid(label: string, detail: string) { voidCount++; console.log(`[VOID] ${label} — ${detail}`); }

async function bscDecimals(): Promise<number | null> {
  try {
    const p = new ethers.JsonRpcProvider(BSC_RPC);
    const c = new ethers.Contract(BSC_USDT, ["function decimals() view returns (uint8)"], p);
    return Number(await c.decimals!());
  } catch { return null; }
}

async function tronDecimals(): Promise<number | null> {
  try {
    const res = await fetch(`${TRON_RPC}/wallet/triggerconstantcontract`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // visible:true + a base58 owner. The hex form is what TronGrid's parser
      // rejected as "INVALID hex String" — and the failure arrived as a VOID,
      // which is why this was found rather than silently passing.
      body: JSON.stringify({ owner_address: "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR", contract_address: TRON_USDT, function_selector: "decimals()", visible: true }),
    });
    const j = (await res.json()) as { constant_result?: string[] };
    const hex = j.constant_result?.[0];
    return hex ? parseInt(hex, 16) : null;
  } catch { return null; }
}

async function main() {
  const bsc = await bscDecimals();
  if (bsc === null) markVoid("BEP20 decimals() unreachable", "no answer from the BSC RPC — this is INCONCLUSIVE, not a pass");
  else check(bsc === EXPECTED.BEP20, "BEP20 USDT decimals() matches configured", `chain says ${bsc}, we use ${EXPECTED.BEP20}`);

  const tron = await tronDecimals();
  if (tron === null) markVoid("TRC20 decimals() unreachable", "no answer from TronGrid — INCONCLUSIVE, not a pass");
  else check(tron === EXPECTED.TRC20, "TRC20 USDT decimals() matches configured", `chain says ${tron}, we use ${EXPECTED.TRC20}`);

  // ⚠️ THE CONTROL THAT MAKES THE TWO ABOVE MEAN ANYTHING: the two chains must
  // DISAGREE with each other. If both came back the same number, either the
  // probe is reading one chain twice or a shared default is being echoed — and
  // "both are 18" is exactly the shape of the 1e12 bug this file exists for.
  if (bsc !== null && tron !== null) {
    check(bsc !== tron, "control: the two chains report DIFFERENT decimals", `BEP20=${bsc} TRC20=${tron} — equal would mean the probe cannot tell them apart`);
  } else markVoid("control: chains differ", "skipped — a chain was unreachable");

  console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${voidCount} VOID`);
  if (voidCount > 0 && fail === 0) { console.log("INCONCLUSIVE — a VOID here means the chain was not asked, NOT that the value is right."); process.exit(2); }
  if (pass === 0) { console.log("VOID — nothing executed"); process.exit(1); }
  process.exit(fail === 0 ? 0 : 1);
}
main();
