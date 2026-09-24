// THE PAYMENT-INTENT STATE MACHINE — pure. One function decides the status
// from the deposits at the intent's address; the observer (and the expiry
// sweep) call it and persist the answer. No I/O here, so the rule is testable
// on its own (scripts/verify-intent-state.ts).
//
//   requires_payment ─tx seen─▶ processing ─Σ confirmed ≥ amount─▶ succeeded
//          │                        │                              (paid on time)
//          └──── expiresAt ─────────┴──▶ expired | expired_partial
//                                          └─ late Σ confirmed ≥ amount ─▶ succeeded_late
//
// Rules, each one a check in the suite:
// - amount_received = Σ CONFIRMED deposits (orphaned and zero-amount never count). It is not
//   stored anywhere; this is the one calculator.
// - PAID when amount_received ≥ amount (overpay allowed: amount_received > amount).
//   ON TIME vs LATE is decided by the detectedAt of the deposit that COMPLETED
//   the amount (cumulative, in detectedAt order) — not by when a tick ran.
// - Past expiresAt and not paid: an in-time tx still confirming keeps the
//   intent `processing`; otherwise expired_partial (something confirmed) or
//   expired (nothing). Once expired*, never back to processing.
// - succeeded and succeeded_late are TERMINAL. Later deposits still raise
//   amount_received (visible on GET) but change nothing else.
// Decimal from the Prisma RUNTIME, not from the generated client: it is the
// SAME class as Prisma.Decimal (what deposit.amount is at runtime), and
// importing it this way keeps this module free of any database client.
import { Decimal } from "@prisma/client/runtime/library";

export type IntentStatus = "requires_payment" | "processing" | "succeeded" | "succeeded_late" | "expired" | "expired_partial";
export type IntentEventType = "payment_intent.succeeded" | "payment_intent.expired";

export interface IntentDeposit {
  txHash: string;
  amount: Decimal;
  status: "detected" | "confirmed" | "orphaned";
  detectedAt: Date;
  confirmations: number;
}

export interface IntentState {
  status: IntentStatus;
  amountReceived: Decimal;
  /** detectedAt of the deposit that completed the amount; null while unpaid. */
  paidAt: Date | null;
  /** Confirmed deposits' tx hashes, in detectedAt order. */
  txHashes: string[];
  /** Fewest confirmations among the confirmed deposits; null when none. */
  confirmations: number | null;
}

const SUCCEEDED: ReadonlySet<IntentStatus> = new Set(["succeeded", "succeeded_late"]);
const EXPIRED: ReadonlySet<IntentStatus> = new Set(["expired", "expired_partial"]);

export function isTerminal(s: IntentStatus): boolean { return SUCCEEDED.has(s); }

export function computeIntentState(input: { amount: Decimal; expiresAt: Date; current: IntentStatus; deposits: IntentDeposit[]; now: Date }): IntentState {
  const { amount, expiresAt, current, now } = input;
  // A ZERO-amount deposit (e.g. BEP20 dust truncated to 6 dp) is not a payment:
  // it never moves an intent to processing and never holds one open (contract A7).
  const live = input.deposits.filter((d) => d.status !== "orphaned" && d.amount.gt(0));
  const confirmed = live
    .filter((d) => d.status === "confirmed")
    .sort((a, b) => a.detectedAt.getTime() - b.detectedAt.getTime() || (a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : 0));
  let amountReceived = new Decimal(0);
  let paidAt: Date | null = null;
  for (const d of confirmed) {
    amountReceived = amountReceived.plus(d.amount);
    if (paidAt === null && amountReceived.gte(amount)) paidAt = d.detectedAt;
  }
  const base = {
    amountReceived,
    paidAt,
    txHashes: confirmed.map((d) => d.txHash),
    confirmations: confirmed.length ? Math.min(...confirmed.map((d) => d.confirmations)) : null,
  };

  if (SUCCEEDED.has(current)) return { status: current, ...base };
  if (paidAt !== null) return { status: paidAt.getTime() <= expiresAt.getTime() ? "succeeded" : "succeeded_late", ...base };
  if (now.getTime() <= expiresAt.getTime() && !EXPIRED.has(current)) {
    return { status: live.length > 0 ? "processing" : "requires_payment", ...base };
  }
  // Past expiry (or already expired) and not paid.
  if (!EXPIRED.has(current)) {
    const inTimeStillConfirming = live.some((d) => d.status === "detected" && d.detectedAt.getTime() <= expiresAt.getTime());
    if (inTimeStillConfirming) return { status: "processing", ...base };
  }
  return { status: amountReceived.gt(0) ? "expired_partial" : "expired", ...base };
}

/** The event a transition emits, if any. At most one per (intent, type) is enforced by the database. */
export function eventForTransition(prev: IntentStatus, next: IntentStatus): IntentEventType | null {
  if (SUCCEEDED.has(next) && !SUCCEEDED.has(prev)) return "payment_intent.succeeded";
  if (EXPIRED.has(next) && !EXPIRED.has(prev)) return "payment_intent.expired";
  return null;
}
