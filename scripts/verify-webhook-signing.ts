// STEP 5 (signing half) — PURE, no database: signs and verifies, tampers,
// expires, and proves the negative controls. Runs anywhere.
import { signPayload, verifySignature, TOLERANCE_SECONDS } from "@/webhooks/sign.js";
let pass = 0, fail = 0;
function check(ok: boolean, label: string, detail = "") { if (ok) pass++; else fail++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`); }
const secret = "whsec_" + "k".repeat(32); const body = JSON.stringify({ id: "evt_1", type: "deposit.confirmed", data: { amount: "10.000000" } });
const now = 1_800_000_000; const sig = signPayload(secret, body, now);
check(/^t=\d+,v1=[0-9a-f]{64}$/.test(sig), "1. signature has the t=,v1= shape", sig.slice(0, 20) + "…");
check(verifySignature(secret, body, sig, now), "2. verifies with the right secret, body and time");
check(!verifySignature(secret, body.replace("10.000000", "10.000001"), sig, now), "3. CONTROL — a one-digit body change fails");
check(!verifySignature("whsec_other", body, sig, now), "4. CONTROL — a different secret fails");
check(!verifySignature(secret, body, sig, now + TOLERANCE_SECONDS + 1), "5. CONTROL — outside the 300 s tolerance fails", `t=${now}, now=${now + TOLERANCE_SECONDS + 1}`);
check(verifySignature(secret, body, sig, now + TOLERANCE_SECONDS), "5b. exactly at the tolerance still verifies (bound checked from both sides)");
check(!verifySignature(secret, body, sig.replace(/v1=./, "v1=x"), now), "6. CONTROL — a malformed header fails");
check(!verifySignature(secret, body, sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0"), now), "7. CONTROL — the last hex digit flipped fails (timing-safe compare still compares)");
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail === 0 ? 0 : 1);
