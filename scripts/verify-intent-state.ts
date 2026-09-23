// COVERS: src/intents/state.ts
//
// S2 slice 1, step 2 (the state machine) — RED-FIRST, PURE: no database, runs
// anywhere. The spec's states, verbatim:
//   requires_payment → processing (tx seen, < confirmations) → succeeded
//   (confirmed, Σ confirmed deposits ≥ amount) | expired (no payment by
//   expiresAt; a LATE payment still records the deposit and moves the intent
//   to succeeded_late — never lost). Overpayment: succeeded with
//   amount_received > amount. Underpayment: stays processing until expiry,
//   then expired_partial.
// Lateness is decided by WHEN THE COMPLETING DEPOSIT WAS SEEN (detectedAt), not
// by when a tick happened to run — so the answer does not depend on timing.
import { Decimal } from "@prisma/client/runtime/library";
import { computeIntentState, eventForTransition, type IntentDeposit, type IntentStatus } from "@/intents/state.js";
import { check, summary } from "./lib/check.js";

const D = (v: string) => new Decimal(v);
const T0 = new Date("2026-09-24T10:00:00Z");
const EXP = new Date("2026-09-24T11:00:00Z");
const before = (min: number) => new Date(EXP.getTime() - min * 60_000);
const after = (min: number) => new Date(EXP.getTime() + min * 60_000);
const dep = (tx: string, amount: string, status: IntentDeposit["status"], detectedAt: Date, confirmations = status === "confirmed" ? 20 : 1): IntentDeposit => ({ txHash: tx, amount: D(amount), status, detectedAt, confirmations });
const run = (deposits: IntentDeposit[], now: Date, current: IntentStatus = "requires_payment", amount = "12.50") => computeIntentState({ amount: D(amount), expiresAt: EXP, current, deposits, now });

let s = run([], before(30));
check(s.status === "requires_payment" && s.amountReceived.eq(0), "1. no deposit, before expiry → requires_payment", s.status);
s = run([dep("a", "12.5", "detected", before(20))], before(10));
check(s.status === "processing" && s.amountReceived.eq(0), "2. a DETECTED (unconfirmed) tx → processing; amount_received counts confirmed only (0)", `${s.status} ${s.amountReceived}`);
s = run([dep("a", "12.5", "confirmed", before(20))], before(10), "processing");
check(s.status === "succeeded" && s.amountReceived.eq("12.5") && s.paidAt?.getTime() === before(20).getTime() && s.txHashes.join() === "a", "3. confirmed exact amount before expiry → succeeded; paidAt = the deposit's detectedAt", `${s.status} ${s.amountReceived}`);
s = run([dep("a", "15", "confirmed", before(20))], before(10), "processing");
check(s.status === "succeeded" && s.amountReceived.eq("15"), "4. OVERPAY → succeeded with amount_received 15 > amount 12.50", `${s.status} ${s.amountReceived}`);
s = run([dep("a", "10", "confirmed", before(20))], before(10), "processing");
check(s.status === "processing" && s.amountReceived.eq("10"), "5. UNDERPAY before expiry → stays processing, amount_received 10 visible", `${s.status} ${s.amountReceived}`);
s = run([dep("a", "10", "confirmed", before(20))], after(1), "processing");
check(s.status === "expired_partial" && s.amountReceived.eq("10"), "5b. UNDERPAY after expiry → expired_partial", s.status);
s = run([], after(1));
check(s.status === "expired" && s.amountReceived.eq(0), "6. nothing paid by expiresAt → expired", s.status);
s = run([dep("a", "12.5", "confirmed", after(5))], after(10), "expired");
check(s.status === "succeeded_late" && s.amountReceived.eq("12.5"), "7. LATE: full payment first seen after expiry → succeeded_late (never lost)", s.status);
s = run([dep("a", "12.5", "confirmed", before(1))], after(10), "processing");
check(s.status === "succeeded", "8. seen BEFORE expiry, confirmed after → succeeded (the customer paid on time)", s.status);
s = run([dep("a", "12.5", "detected", before(1))], after(10), "processing");
check(s.status === "processing", "9. an in-time tx still confirming at expiry keeps the intent processing, not expired", s.status);
s = run([dep("a", "12.5", "detected", after(1))], after(10), "requires_payment");
check(s.status === "expired", "9b. CONTROL — a tx first seen AFTER expiry does not hold the intent open", s.status);
s = run([dep("b", "6.25", "confirmed", before(10)), dep("a", "6.25", "confirmed", before(30))], before(5), "processing");
check(s.status === "succeeded" && s.amountReceived.eq("12.5") && s.paidAt?.getTime() === before(10).getTime() && s.txHashes.join() === "a,b", "10. two partials summing to the amount → succeeded; paidAt = the COMPLETING deposit; tx_hashes in order", `${s.paidAt?.toISOString()} ${s.txHashes.join()}`);
s = run([dep("a", "6.25", "confirmed", before(30)), dep("b", "6.25", "confirmed", after(2))], after(5), "expired_partial");
check(s.status === "succeeded_late", "11. partial in time + completion after expiry → succeeded_late", s.status);
s = run([dep("a", "12.5", "confirmed", before(30)), dep("b", "5", "confirmed", before(2))], before(1), "succeeded");
check(s.status === "succeeded" && s.amountReceived.eq("17.5"), "12. TERMINAL: succeeded stays succeeded; a later deposit still raises amount_received", `${s.status} ${s.amountReceived}`);
s = run([dep("a", "12.5", "orphaned", before(30))], before(1), "processing");
check(s.status === "requires_payment" && s.amountReceived.eq(0), "13. an orphaned deposit counts for nothing", s.status);
s = run([dep("a", "5", "confirmed", before(30)), dep("b", "1", "detected", after(3))], after(5), "expired_partial");
check(s.status === "expired_partial" && s.amountReceived.eq("5"), "14. expired_partial + a late tx that does not complete it → stays expired_partial (never back to processing)", s.status);
s = run([dep("a", "12.499999", "confirmed", before(30))], before(1), "processing");
check(s.status === "processing", "15. 12.499999 < 12.50 → not paid (Decimal, never a float)", s.status);
s = run([dep("a", "12.5", "confirmed", T0)], T0, "succeeded_late");
check(s.status === "succeeded_late", "16. succeeded_late is terminal too", s.status);
check(s.confirmations === 20, "16b. confirmations = the fewest among the counted deposits", String(s.confirmations));

const E = eventForTransition;
check(E("processing", "succeeded") === "payment_intent.succeeded" && E("expired", "succeeded_late") === "payment_intent.succeeded" && E("requires_payment", "succeeded") === "payment_intent.succeeded", "17. entering succeeded / succeeded_late emits payment_intent.succeeded");
check(E("processing", "expired_partial") === "payment_intent.expired" && E("requires_payment", "expired") === "payment_intent.expired", "17b. entering expired / expired_partial emits payment_intent.expired");
check(E("succeeded", "succeeded") === null && E("expired", "expired_partial") === null && E("processing", "processing") === null && E("requires_payment", "processing") === null, "17c. no event within a family or for processing");

process.exit(summary());
