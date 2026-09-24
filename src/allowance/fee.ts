// THE MERCHANT FEE — ONE CALCULATOR (contract §0, §4 Balance).
//
// fee = amount × fee_bps / 10000, TRUNCATED (rounded DOWN) to 6 decimals.
// Down, never up: the rate is a ceiling the merchant agreed to, and a fee of
// 0.0000009 on a 0.000009 deposit is 0, not 0.000001 (which would be 11%).
//
// The fee is deducted from the merchant's GATEWAY balance, never from the
// customer's store credit — the store credits the full amount_received.
//
// WHO CALLS IT: the observer, in the SAME update that flips a deposit
// detected → confirmed, via feeForConfirmation(), and writes the result to
// deposits.fee_amount. After that the stamped value is the only figure: the
// balance and the allowance SUM the column and never recompute it, so a
// later change of clients.fee_bps never rewrites a past fee.
// No database client import on purpose: scripts/issue-key.ts loads this (via
// src/keys/terms.ts) BEFORE its TTY check, and nothing may touch the DB first.
import { Prisma } from "@prisma/client";
import type { Tx } from "./types.js";

export const MAX_FEE_BPS = 10_000;

export class InvalidFeeBps extends Error {
  constructor(readonly feeBps: unknown) {
    super(`fee_bps must be an integer 0..${MAX_FEE_BPS}, got ${String(feeBps)}`);
    this.name = "InvalidFeeBps";
  }
}

export function assertFeeBps(feeBps: number): void {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_FEE_BPS) throw new InvalidFeeBps(feeBps);
}

/** amount × feeBps / 10000, rounded DOWN to 6 dp. Pure. */
export function computeFee(amount: Prisma.Decimal | string, feeBps: number): Prisma.Decimal {
  assertFeeBps(feeBps);
  const a = new Prisma.Decimal(amount);
  if (!a.isFinite() || a.isNegative()) throw new Error(`computeFee: amount must be a non-negative decimal, got ${a.toString()}`);
  return a.times(feeBps).dividedBy(MAX_FEE_BPS).toDecimalPlaces(6, Prisma.Decimal.ROUND_DOWN);
}

/**
 * The fee to stamp on a deposit that is being confirmed now: the key's
 * client's CURRENT fee_bps applied to `amount`. Call inside the observer's
 * confirming transaction and write the result into deposits.fee_amount in the
 * same update that sets status = confirmed.
 */
export async function feeForConfirmation(tx: Tx, keyId: string, amount: Prisma.Decimal | string): Promise<Prisma.Decimal> {
  const key = await tx.clientKey.findUnique({ where: { id: keyId }, select: { client: { select: { feeBps: true } } } });
  if (!key) throw new Error(`feeForConfirmation: no key ${keyId}`);
  return computeFee(amount, key.client.feeBps);
}
