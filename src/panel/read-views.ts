// Everything the phase-1 dashboard READS. No writes, no money movement — the
// withdrawal surface is unmounted and stays that way (contract §4, app.ts:8-11).
//
// Two rules this file is built on:
//  · TENANCY BY OWNERSHIP, NOT BY PARAMETER. Each function resolves the
//    caller's clients through AccountClient and then filters by that set, so a
//    guessed id in a query string is a row that simply is not in the answer.
//  · THE MATH IS SHOWN, NOT ASSERTED. `GET /v1/balance` returns `available`; a
//    customer looking at a wallet wants to see received − fees − withdrawn,
//    because that is the only version of the number they can check themselves
//    against the chain. `allowance` is never clamped: a negative here is a
//    defect made visible, exactly as src/allowance/read.ts argues.
import { Prisma, type Chain } from "@prisma/client";
import { prisma } from "@/db/client.js";
import { BALANCE_CHAINS, readClientByChain } from "@/allowance/index.js";
import { visibleClientIds } from "./keys.js";

export type ViewRefusal = { code: "not_found" };

export interface BalanceView {
  clientId: string; feeBps: number;
  chains: Record<Chain, { received: string; fees: string; withdrawn: string; available: string; pending: string }>;
  note: string;
}

export async function balanceView(accountId: string, clientId: string): Promise<BalanceView | ViewRefusal> {
  if (!(await visibleClientIds(accountId)).includes(clientId)) return { code: "not_found" };
  const [byChain, client] = await Promise.all([
    readClientByChain(clientId),
    prisma.client.findUnique({ where: { id: clientId }, select: { feeBps: true } }),
  ]);
  const chains = {} as BalanceView["chains"];
  for (const chain of BALANCE_CHAINS) {
    const p = byChain[chain];
    chains[chain] = { received: p.received.toString(), fees: p.fees.toString(), withdrawn: p.withdrawn.toString(), available: p.available.toString(), pending: p.pending.toString() };
  }
  return {
    clientId, feeBps: client?.feeBps ?? 0, chains,
    note: "available = confirmed deposits − stamped fees − withdrawals still consuming. Pending counts detected-but-unconfirmed deposits gross; a later fee is stamped at confirmation, so pending can shrink.",
  };
}

// The columns a merchant actually reads off a deposit. `feeAmount` is the
// gateway fee STAMPED at confirmation, so the number on the row is the number
// that was taken — a merchant reconciles against it, not against a rate they
// remember.
const DEPOSIT_SELECT = {
  id: true, chain: true, address: true, txHash: true, amount: true, feeAmount: true,
  confirmations: true, status: true, detectedAt: true, creditedAt: true, keyId: true,
  addressId: true,
} satisfies Prisma.DepositSelect;

export async function depositsView(accountId: string, input: { clientId: string; chain?: Chain; reference?: string; limit?: number; before?: Date }) {
  if (!(await visibleClientIds(accountId)).includes(input.clientId)) return { code: "not_found" as const, rows: null };
  const rows = await prisma.deposit.findMany({
    // `reference` is the customer attribution, and it lives on the ADDRESS a
    // deposit landed at (the address owns one reference for life) — never on the
    // deposit row. Filtering here is a join, and it is the same join the
    // merchant's own GET /v1/deposits?reference= makes.
    where: {
      clientId: input.clientId,
      ...(input.chain ? { chain: input.chain } : {}),
      ...(input.reference ? { address: { reference: input.reference } } : {}),
      ...(input.before ? { detectedAt: { lt: input.before } } : {}),
    },
    select: { ...DEPOSIT_SELECT, address: { select: { reference: true } } },
    orderBy: { detectedAt: "desc" },
    take: Math.min(100, Math.max(1, input.limit ?? 25)),
  });
  return { code: "ok" as const, rows };
}

const INTENT_SELECT = {
  id: true, reference: true, chain: true, amount: true, status: true,
  createdAt: true, expiresAt: true, succeededAt: true, expiredAt: true, keyId: true,
  addressId: true,
} satisfies Prisma.PaymentIntentSelect;

export async function intentsView(accountId: string, input: { clientId: string; status?: string; limit?: number }) {
  if (!(await visibleClientIds(accountId)).includes(input.clientId)) return { code: "not_found" as const, rows: null };
  const rows = await prisma.paymentIntent.findMany({
    where: { clientId: input.clientId, ...(input.status ? { status: input.status as never } : {}) },
    select: INTENT_SELECT,
    orderBy: { createdAt: "desc" },
    take: Math.min(100, Math.max(1, input.limit ?? 25)),
  });
  return { code: "ok" as const, rows };
}

/** SamaPay's own address book for this client. This is the list the API never
 *  exposed (pay-dashboard.md A.6: "a dashboard cannot show it without a new
 *  route") and the panel needs: which of my customers have a permanent
 *  address, on which chain, and whether it is a legacy import. */
export async function addressesView(accountId: string, input: { clientId: string; chain?: Chain; referencePrefix?: string; limit?: number }) {
  if (!(await visibleClientIds(accountId)).includes(input.clientId)) return { code: "not_found" as const, rows: null };
  const rows = await prisma.address.findMany({
    where: {
      clientId: input.clientId,
      ...(input.chain ? { chain: input.chain } : {}),
      ...(input.referencePrefix ? { reference: { startsWith: input.referencePrefix } } : {}),
    },
    select: {
      id: true, chain: true, address: true, reference: true, keyId: true, createdAt: true,
      watchDisabledAt: true, legacyImport: true, derivationIndex: true,
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(200, Math.max(1, input.limit ?? 50)),
  });
  return { code: "ok" as const, rows };
}

/** The client's own audit rows, plus the rows whose actor is the CALLER.
 *  The second half is the panel's own history (sign-ins, handoffs) — those rows
 *  carry no keyId, so a key-scoped filter would show a merchant nothing about
 *  their own account.
 *
 *  ⚠️ A `cli:ibrahim` row appears ONLY when its key belongs to one of this
 *  account's clients: that is what makes the row theirs. Rows naming nobody and
 *  nothing (keyId null, actor not this account) are never in this answer. */
export async function auditView(accountId: string, input: { clientId: string; limit?: number; since?: Date }) {
  if (!(await visibleClientIds(accountId)).includes(input.clientId)) return { code: "not_found" as const, rows: null };
  const keys = await prisma.clientKey.findMany({ where: { clientId: input.clientId }, select: { id: true } });
  const rows = await prisma.auditEvent.findMany({
    where: {
      OR: [{ keyId: { in: keys.map((k) => k.id) } }, { actor: `account:${accountId}` }],
      ...(input.since ? { at: { gte: input.since } } : {}),
    },
    select: { id: true, at: true, keyId: true, actor: true, action: true, subjectId: true, params: true },
    orderBy: { at: "desc" },
    take: Math.min(200, Math.max(1, input.limit ?? 50)),
  });
  return { code: "ok" as const, rows };
}
