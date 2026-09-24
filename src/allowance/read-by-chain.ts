// PER-CHAIN POSITION — what GET /v1/balance renders (contract §4 Balance).
//
// For each chain, over THIS KEY's rows (the allowance is per key — THE ONE
// RULE; a merchant has one live key):
//   available = Σ confirmed deposits.amount − Σ their fee_amount − withdrawn
//   pending   = Σ detected deposits.amount (gross; the fee is stamped only
//               when the deposit confirms, so none is known yet)
// `withdrawn` uses the same CONSUMING set as read(): every status except
// RETURNED_STATUSES. Never clamped, never rounded — a negative is a defect
// made visible. Σ over chains of `available` equals read().allowance
// (asserted in scripts/verify-fees-balance.ts), so the display and the
// withdrawal bound cannot drift apart.
import { Prisma, type Chain } from "@prisma/client";
import { prisma } from "@/db/client.js";
import { RETURNED_STATUSES, type Tx } from "./types.js";

export const BALANCE_CHAINS: readonly Chain[] = ["TRC20", "BEP20"] as const;

export interface ChainPosition {
  received: Prisma.Decimal;
  fees: Prisma.Decimal;
  withdrawn: Prisma.Decimal;
  available: Prisma.Decimal;
  pending: Prisma.Decimal;
}

export async function readByChain(keyId: string, tx: Pick<typeof prisma, "deposit" | "withdrawal"> | Tx = prisma): Promise<Record<Chain, ChainPosition>> {
  const [deps, outs] = await Promise.all([
    tx.deposit.groupBy({ by: ["chain", "status"], _sum: { amount: true, feeAmount: true }, where: { keyId, status: { in: ["confirmed", "detected"] } } }),
    tx.withdrawal.groupBy({ by: ["chain"], _sum: { amount: true }, where: { keyId, status: { notIn: [...RETURNED_STATUSES] } } }),
  ]);
  const zero = () => new Prisma.Decimal(0);
  const result = {} as Record<Chain, ChainPosition>;
  for (const chain of BALANCE_CHAINS) {
    const confirmed = deps.find((d) => d.chain === chain && d.status === "confirmed");
    const detected = deps.find((d) => d.chain === chain && d.status === "detected");
    const received = confirmed?._sum.amount ?? zero();
    const fees = confirmed?._sum.feeAmount ?? zero();
    const withdrawn = outs.find((w) => w.chain === chain)?._sum.amount ?? zero();
    result[chain] = { received, fees, withdrawn, available: received.minus(fees).minus(withdrawn), pending: detected?._sum.amount ?? zero() };
  }
  return result;
}
