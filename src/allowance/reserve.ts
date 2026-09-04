import { Prisma, type Chain } from "@prisma/client";
import { read } from "./read.js";
import { AllowanceExceeded, InvalidAmount, type Tx } from "./types.js";

export interface ReserveInput {
  keyId: string;
  amount: Prisma.Decimal | string;
  /** The client's idempotency key. A replay returns the existing row and consumes nothing. */
  idempotencyKey: string;
  toAddress: string;
  chain: Chain;
  reference?: string | null;
  /** Stored beside the row; never enters the allowance (clause 3). */
  fee?: Prisma.Decimal | string;
}

export interface ReserveResult {
  withdrawalId: string;
  reservationId: string;
  replayed: boolean;
  /** The position AFTER this reservation was counted (or the current one, on replay). */
  position: Awaited<ReturnType<typeof read>>;
}

/** Namespace for the per-key allowance lock. Own namespace so an unrelated advisory lock hashing to the same key cannot collide. */
export const ALLOWANCE_LOCK_NAMESPACE = 4712;

/**
 * Reserve `amount` of `keyId`'s allowance by inserting the PENDING
 * withdrawal row, inside the caller's transaction. Clauses 4–7, 9.
 *
 * ORDER, and it is the whole guarantee:
 *   1. the advisory lock on the key — FIRST STATEMENT, before any read.
 *      Two callers sharing one allowance hold no common row lock (they
 *      may be different customers of the same key); without this both
 *      read the same `withdrawn` and both pass. Measured in SamaPrime.
 *   2. the replay check — same key + idempotency key returns the existing
 *      row; a retried request must never consume twice.
 *   3. the aggregate — now serialised behind the lock.
 *   4. refuse iff withdrawn + amount > received. Exactly, not at-most.
 *   5. insert the withdrawal (pending) and the reservation (held, NO
 *      amount of its own — the withdrawal row is the single figure that
 *      enters any sum; a second amount column would be two calculators).
 *
 * The caller appends the audit event (src/audit) after this returns.
 */
export async function reserve(tx: Tx, input: ReserveInput): Promise<ReserveResult> {
  const amount = new Prisma.Decimal(input.amount);
  if (!amount.isFinite() || !amount.isPositive() || amount.isZero()) throw new InvalidAmount(amount.toString());
  const fee = new Prisma.Decimal(input.fee ?? 0);

  // 1. Serialise per key. `::int4` casts are required — Prisma binds a JS
  //    number as bigint and there is no (bigint, int) overload.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ALLOWANCE_LOCK_NAMESPACE}::int4, hashtext(${input.keyId})::int4)`;

  // 2. Replay.
  const existing = await tx.withdrawal.findUnique({
    where: { keyId_idempotencyKey: { keyId: input.keyId, idempotencyKey: input.idempotencyKey } },
    select: { id: true, reservation: { select: { id: true } } },
  });
  if (existing) {
    return { withdrawalId: existing.id, reservationId: existing.reservation?.id ?? "", replayed: true, position: await read(input.keyId, tx) };
  }

  // 3–4. The rule.
  const before = await read(input.keyId, tx);
  if (before.withdrawn.plus(amount).greaterThan(before.received)) {
    throw new AllowanceExceeded(input.keyId, before.received.toString(), before.withdrawn.toString(), amount.toString());
  }

  // 5. The pending row IS the reservation's amount; the reservation row carries none.
  const withdrawal = await tx.withdrawal.create({
    data: {
      keyId: input.keyId,
      reference: input.reference ?? null,
      toAddress: input.toAddress,
      chain: input.chain,
      amount,
      fee,
      status: "pending",
      idempotencyKey: input.idempotencyKey,
    },
    select: { id: true },
  });
  const reservation = await tx.reservation.create({
    data: { keyId: input.keyId, withdrawalId: withdrawal.id, status: "held" },
    select: { id: true },
  });
  return { withdrawalId: withdrawal.id, reservationId: reservation.id, replayed: false, position: await read(input.keyId, tx) };
}
