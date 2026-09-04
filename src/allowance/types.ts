// =====================================================================
// *** THE ONE RULE: NOTHING LEAVES OUR WALLET THAT DID NOT ENTER IT. ***
// =====================================================================
// Ibrahim, 2026-09-03, verbatim: "allowance(key) = USDT RECEIVED ON-CHAIN
// under that key − withdrawn. Manual deposits never count."
//
// This module is pure money math and state transitions. No HTTP, no
// chain calls, no audit-chain writes (the caller appends the audit event
// through src/audit so the hash chain has one writer).
//
// THE CLAUSES, carried over from SamaPrime's Slice B where each one was
// earned by a measurement (docs/scratch/samapay-cut-money-semantics-2026-09-04.md
// in the SamaPrime repo):
//   1. received(key)  = Σ deposits.amount WHERE key AND status = confirmed.
//      Chain observation ONLY. No function in this module — and no
//      endpoint anywhere — adds to it.
//   2. withdrawn(key) = Σ withdrawals.amount WHERE key AND status NOT IN
//      the RETURNED set {cancelled, expired, refunded, rejected}. `failed`
//      and `send_unknown` KEEP consuming until an explicit `refunded`
//      backed by evidence. Under-allow is the safe direction.
//   3. The fee is excluded from both sides — it never leaves on-chain.
//   4. Exactly, not at-most: refuse iff withdrawn + requested > received.
//   5. The refusal is its own error and carries the three numbers.
//   6. SERIALISE PER KEY BEFORE READING THE AGGREGATE (the first statement
//      of reserve()). Measured in SamaPrime: two callers sharing one
//      allowance, no shared lock, READ COMMITTED → both passed, allowance
//      went to −10.
//   7. Every withdrawal row names its key; nothing is ever backfilled.
//   8. The allowance is NEVER clamped or rounded up to zero. A negative
//      is a bug made visible.
//   9. Concurrency is asserted as EXACTLY one of two wins.
import { Prisma, type WithdrawalStatus } from "@prisma/client";

/** Statuses in which the customer's money was RETURNED — the only ones that stop consuming. */
export const RETURNED_STATUSES: readonly WithdrawalStatus[] = ["cancelled", "expired", "refunded", "rejected"] as const;

export interface AllowancePosition {
  keyId: string;
  received: Prisma.Decimal;
  withdrawn: Prisma.Decimal;
  /** received − withdrawn. Never clamped. */
  allowance: Prisma.Decimal;
  depositCount: number;
  withdrawalCount: number;
}

export class AllowanceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AllowanceError";
  }
}

/** Clause 5: the refusal names itself and carries the figures. Maps to HTTP 409 allowance_exceeded. */
export class AllowanceExceeded extends AllowanceError {
  constructor(
    readonly keyId: string,
    readonly received: string,
    readonly withdrawn: string,
    readonly requested: string,
  ) {
    super("allowance_exceeded", `Only money that arrived on-chain under this key can be sent. Received ${received}, already withdrawn ${withdrawn}, requested ${requested}.`);
    this.name = "AllowanceExceeded";
  }
}

export class InvalidAmount extends AllowanceError {
  constructor(amount: string) {
    super("invalid_amount", `Amount must be a positive number of USDT, got ${amount}.`);
    this.name = "InvalidAmount";
  }
}

export class NotReleasable extends AllowanceError {
  constructor(readonly withdrawalId: string, readonly status: string) {
    super("not_releasable", `Withdrawal ${withdrawalId} is ${status}; only a pending reservation can be released.`);
    this.name = "NotReleasable";
  }
}

export class RefundNeedsEvidence extends AllowanceError {
  constructor(readonly withdrawalId: string, why: string) {
    super("refund_needs_evidence", `Withdrawal ${withdrawalId} cannot be marked refunded: ${why}`);
    this.name = "RefundNeedsEvidence";
  }
}

export class NotRefundable extends AllowanceError {
  constructor(readonly withdrawalId: string, readonly status: string) {
    super("not_refundable", `Withdrawal ${withdrawalId} is ${status}; only failed or send_unknown can be refunded.`);
    this.name = "NotRefundable";
  }
}

export type Tx = Prisma.TransactionClient;
