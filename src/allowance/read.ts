import { Prisma } from "@prisma/client";
import { prisma } from "@/db/client.js";
import { RETURNED_STATUSES, type AllowancePosition, type Tx } from "./types.js";

/**
 * allowance(key) = received − withdrawn. Clauses 1, 2, 3, 8.
 *
 * Reads two aggregates and subtracts. Takes the caller's transaction so
 * reserve() reads under its own lock; outside a transaction it is a plain
 * read for GET /balance. The result is never clamped: a negative
 * allowance is a defect made visible, and GET /balance must show it.
 */
// ⚠️ IBRAHIM'S DECISION, 2026-09-06, VERBATIM — WRITTEN HERE BECAUSE THIS IS
// THE AGGREGATE SOMEBODY WILL WIDEN:
//   "ALLOWANCE PER (CHANNEL, CURRENCY) — USDT, ShamCash-SYP, ShamCash-USD are
//    SEPARATE LEDGERS. A verifier-confirmed inflow COVERS A PAYOUT ON ITS OWN
//    CHANNEL ONLY, NEVER ACROSS."
// So the allowance key is (keyId, channel, currency) — one channel can carry
// two currencies and those are two ledgers. TODAY this aggregate filters on
// keyId and status only: it is correct BY ABSENCE (one channel, one currency
// exist) and not by guard. C2 of docs/panel-survey-2026-09-06.md adds
// `channel` and `currency` to payments and payouts and puts both in this
// WHERE; until then a second currency here is a 100,000 SYP + 100 USDT =
// 100,100-of-nothing defect. Separate ledgers with no crossing also means
// NO FX INSIDE SAMAPAY — that is his answer by implication, not an opening.
// Consequence, not a separate policy: 4reply's word can pay out ShamCash
// and can never pay out USDT, because the ledgers never touch.
export async function read(keyId: string, tx: Pick<typeof prisma, "deposit" | "withdrawal"> | Tx = prisma): Promise<AllowancePosition> {
  const [inn, out] = await Promise.all([
    tx.deposit.aggregate({ _sum: { amount: true }, _count: { _all: true }, where: { keyId, status: "confirmed" } }),
    tx.withdrawal.aggregate({ _sum: { amount: true }, _count: { _all: true }, where: { keyId, status: { notIn: [...RETURNED_STATUSES] } } }),
  ]);
  const received = inn._sum.amount ?? new Prisma.Decimal(0);
  const withdrawn = out._sum.amount ?? new Prisma.Decimal(0);
  return { keyId, received, withdrawn, allowance: received.minus(withdrawn), depositCount: inn._count._all, withdrawalCount: out._count._all };
}
