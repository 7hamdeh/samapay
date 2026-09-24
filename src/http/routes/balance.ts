// GET /v1/balance → the contract §4 Balance object, per chain, for the
// calling KEY (the allowance is per key — THE ONE RULE; a merchant has one
// live key):
//   { object:"balance", currency:"USDT",
//     chains:{ TRC20:{available,pending}, BEP20:{available,pending} }, fee_bps }
// available = confirmed − stamped fees − consuming withdrawals; pending =
// detected, gross. Straight from allowance.readByChain(); never clamped,
// never rounded. `fee_bps` is the client's CURRENT rate — the one the next
// confirmation will be stamped with, not a recomputation of past fees.
import { Hono } from "hono";
import { prisma } from "@/db/client.js";
import { read, readByChain, readByReference, BALANCE_CHAINS } from "@/allowance/index.js";
import { bearerAuth, requireScope } from "../auth.js";
import { ApiError } from "../errors.js";

export function positionBody(p: Awaited<ReturnType<typeof read>>) {
  return { key_id: p.keyId, received: p.received.toString(), fees: p.fees.toString(), withdrawn: p.withdrawn.toString(), allowance: p.allowance.toString(), deposit_count: p.depositCount, withdrawal_count: p.withdrawalCount };
}

export async function balanceBody(keyId: string, clientId: string) {
  const [byChain, client] = await Promise.all([
    readByChain(keyId),
    prisma.client.findUnique({ where: { id: clientId }, select: { feeBps: true } }),
  ]);
  if (!client) throw new ApiError("not_found", "No such client.");
  const chains: Record<string, { available: string; pending: string }> = {};
  for (const chain of BALANCE_CHAINS) chains[chain] = { available: byChain[chain].available.toString(), pending: byChain[chain].pending.toString() };
  return { object: "balance" as const, currency: "USDT" as const, chains, fee_bps: client.feeBps };
}

export const balance = new Hono();
balance.use("*", bearerAuth);
balance.get("/", async (c) => {
  const key = c.get("key");
  requireScope(key, "balance.read");
  const reference = c.req.query("reference");
  if (reference !== undefined) {
    // ⚠️ RECONCILIATION, NOT A BOUND. No `allowance` field here, on purpose:
    // the allowance is per KEY and there is exactly one. See
    // docs/model-correction-2026-09-04.md §3-§4.
    const p = await readByReference(key.id, reference);
    return c.json({ reference_position: { key_id: p.keyId, reference: p.reference, received: p.received.toString(), withdrawn: p.withdrawn.toString(), deposit_count: p.depositCount, withdrawal_count: p.withdrawalCount, note: "reconciliation only — the allowance is per key, not per reference" } }, 200);
  }
  return c.json(await balanceBody(key.id, key.clientId), 200);
});
