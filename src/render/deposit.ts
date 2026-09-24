// THE Deposit object (contract §4) — ONE renderer (lead ruling 2026-09-24).
// GET /v1/deposits (+/:id) and the `deposit.confirmed` event snapshot (G2's
// observer) both call renderDeposit on a row read with DEPOSIT_RENDER_SELECT,
// so the REST body and the webhook body cannot drift.
//   id         the PUBLIC id "dep_<row id>" (contract §4). parseDepositId()
//              is the only way back; an unprefixed id is not an id.
//   reference  an intent's address carries "payment_intent:<pi>" internally
//              (G2); for an intent deposit the store's reference is the
//              INTENT's, so that is what is rendered.
import type { Prisma } from "@prisma/client";

export const DEPOSIT_ID_PREFIX = "dep_";

export const DEPOSIT_RENDER_SELECT = {
  id: true, chain: true, txHash: true, amount: true, confirmations: true, status: true, detectedAt: true, creditedAt: true,
  address: { select: { reference: true, address: true, intent: { select: { id: true, reference: true } } } },
} as const satisfies Prisma.DepositSelect;
export type DepositRenderRow = Prisma.DepositGetPayload<{ select: typeof DEPOSIT_RENDER_SELECT }>;

export interface DepositObject {
  id: string; object: "deposit"; status: DepositRenderRow["status"]; chain: DepositRenderRow["chain"];
  tx_hash: string; amount: string; confirmations: number; address: string; reference: string;
  payment_intent_id: string | null; detected_at: string; confirmed_at: string | null;
}

export function publicDepositId(rowId: string): string { return `${DEPOSIT_ID_PREFIX}${rowId}`; }

/** "dep_<row id>" → row id; anything else → null (the caller answers 404). */
export function parseDepositId(publicId: string): string | null {
  if (!publicId.startsWith(DEPOSIT_ID_PREFIX)) return null;
  const rowId = publicId.slice(DEPOSIT_ID_PREFIX.length);
  return /^[A-Za-z0-9]{1,64}$/.test(rowId) ? rowId : null;
}

export function renderDeposit(d: DepositRenderRow): DepositObject {
  return {
    id: publicDepositId(d.id), object: "deposit", status: d.status, chain: d.chain, tx_hash: d.txHash, amount: d.amount.toFixed(),
    confirmations: d.confirmations, address: d.address.address,
    reference: d.address.intent?.reference ?? d.address.reference,
    payment_intent_id: d.address.intent?.id ?? null,
    detected_at: d.detectedAt.toISOString(), confirmed_at: d.creditedAt?.toISOString() ?? null,
  };
}
