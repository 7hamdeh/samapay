// A PaymentIntent exactly as the contract renders it (§4), from the database.
// ONE renderer: the event snapshot (engine) and GET /v1/payment-intents (G1)
// must show the same object, so both call this. amount_received, fee_amount
// and tx_hashes are DERIVED here from the intent's deposits through
// computeIntentState — they are not stored anywhere.
import type { Chain, Prisma } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { computeIntentState, type IntentDeposit, type IntentStatus } from "./state.js";

type Db = Prisma.TransactionClient;

export const INTENT_SELECT = {
  id: true, clientId: true, keyId: true, chain: true, amount: true, reference: true, status: true,
  expiresAt: true, succeededAt: true, expiredAt: true, createdAt: true,
  address: {
    select: {
      address: true,
      deposits: { select: { txHash: true, amount: true, status: true, detectedAt: true, confirmations: true, feeAmount: true } },
    },
  },
} as const satisfies Prisma.PaymentIntentSelect;
export type IntentRow = Prisma.PaymentIntentGetPayload<{ select: typeof INTENT_SELECT }>;

export interface PaymentIntentObject {
  id: string; object: "payment_intent"; status: IntentStatus;
  amount: string; amount_received: string; fee_amount: string; currency: "USDT";
  chain: Chain; address: string; reference: string; tx_hashes: string[]; confirmations_required: number;
  expires_at: string; created_at: string; succeeded_at: string | null; expired_at: string | null;
}

export function intentDeposits(row: IntentRow): IntentDeposit[] {
  return row.address.deposits.map((d) => ({ txHash: d.txHash, amount: d.amount, status: d.status, detectedAt: d.detectedAt, confirmations: d.confirmations }));
}

/** Money as a plain decimal string — toFixed() never switches to exponent notation. */
const money = (d: Decimal) => d.toFixed();

export function renderPaymentIntent(row: IntentRow, confirmationsRequired: number, now = new Date()): PaymentIntentObject {
  // Status is the STORED one (what the engine last persisted); the derived
  // figures come from the same deposits the engine read.
  const s = computeIntentState({ amount: row.amount, expiresAt: row.expiresAt, current: row.status, deposits: intentDeposits(row), now });
  const fee = row.address.deposits.filter((d) => d.status === "confirmed").reduce((acc, d) => acc.plus(d.feeAmount), new Decimal(0));
  return {
    id: row.id, object: "payment_intent", status: row.status,
    amount: money(row.amount), amount_received: money(s.amountReceived), fee_amount: money(fee), currency: "USDT",
    chain: row.chain, address: row.address.address, reference: row.reference, tx_hashes: s.txHashes,
    confirmations_required: confirmationsRequired,
    expires_at: row.expiresAt.toISOString(), created_at: row.createdAt.toISOString(),
    succeeded_at: row.succeededAt?.toISOString() ?? null, expired_at: row.expiredAt?.toISOString() ?? null,
  };
}

export async function loadIntentRow(db: Db, id: string): Promise<IntentRow | null> {
  return db.paymentIntent.findUnique({ where: { id }, select: INTENT_SELECT });
}
