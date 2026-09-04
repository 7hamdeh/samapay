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
export async function read(keyId: string, tx: Pick<typeof prisma, "deposit" | "withdrawal"> | Tx = prisma): Promise<AllowancePosition> {
  const [inn, out] = await Promise.all([
    tx.deposit.aggregate({ _sum: { amount: true }, _count: { _all: true }, where: { keyId, status: "confirmed" } }),
    tx.withdrawal.aggregate({ _sum: { amount: true }, _count: { _all: true }, where: { keyId, status: { notIn: [...RETURNED_STATUSES] } } }),
  ]);
  const received = inn._sum.amount ?? new Prisma.Decimal(0);
  const withdrawn = out._sum.amount ?? new Prisma.Decimal(0);
  return { keyId, received, withdrawn, allowance: received.minus(withdrawn), depositCount: inn._count._all, withdrawalCount: out._count._all };
}
