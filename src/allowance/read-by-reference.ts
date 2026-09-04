// PER-REFERENCE READ — RECONCILIATION ONLY, DELIBERATELY NOT A BOUND.
//
// ⚠️ WRITTEN BY providers-rules FOR value-model's REVIEW (she owns
// src/allowance). Shape agreed in the 2026-09-04 model-correction exchange.
//
// Ibrahim's own minimal API listed `GET /balance (reference?)`. Under the
// corrected client model this is the ONLY instrument SamaPrime has to check
// its internal per-merchant ledger against SamaPay's independent numbers —
// the "find an instrument on the other side" rule applied to our own two
// systems.
//
// *** IT RETURNS received AND withdrawn AND NOTHING ELSE. *** There is NO
// `allowance` field, on purpose: the allowance is PER KEY and there is
// exactly one. A per-reference allowance would refuse withdrawal of money
// EARNED inside SamaPrime (margin, commission, an internal transfer), which
// has no on-chain inflow under its own reference — see
// docs/model-correction-2026-09-04.md §3. Do not add the field "for
// symmetry": the absence is the design.
import { Prisma } from "@prisma/client";
import { prisma } from "@/db/client.js";
import { RETURNED_STATUSES, type Tx } from "./types.js";

export interface ReferencePosition {
  keyId: string;
  reference: string;
  received: Prisma.Decimal;
  withdrawn: Prisma.Decimal;
  depositCount: number;
  withdrawalCount: number;
}

export async function readByReference(
  keyId: string,
  reference: string,
  tx: Pick<typeof prisma, "deposit" | "withdrawal"> | Tx = prisma,
): Promise<ReferencePosition> {
  const [inn, out] = await Promise.all([
    // deposits carry their reference through the ADDRESS they landed at —
    // attribution created at derivation time, never inferred later.
    tx.deposit.aggregate({ _sum: { amount: true }, _count: { _all: true }, where: { keyId, status: "confirmed", address: { reference } } }),
    tx.withdrawal.aggregate({ _sum: { amount: true }, _count: { _all: true }, where: { keyId, reference, status: { notIn: [...RETURNED_STATUSES] } } }),
  ]);
  return {
    keyId,
    reference,
    received: inn._sum.amount ?? new Prisma.Decimal(0),
    withdrawn: out._sum.amount ?? new Prisma.Decimal(0),
    depositCount: inn._count._all,
    withdrawalCount: out._count._all,
  };
}
