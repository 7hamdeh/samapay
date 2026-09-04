// *** THE ONLY WRITER OF `deposits`. *** value-model's structural suite greps
// src/ for deposit writes with this directory as its present-control; a
// `deposit.create` anywhere else is a defect by definition.
//
// What it does: takes a ChainObserver (interface; the real scanner moves in
// at step 4) and the set of addresses SamaPay has issued, records every
// transfer to one of them ONCE (UNIQUE(chain, tx_hash) makes a second
// record impossible, not merely unlikely), and promotes `detected` →
// `confirmed` exactly once when confirmations reach the chain's threshold —
// setting credited_at, appending the audit row and enqueuing the webhook in
// the same transaction. Allowance is never written here: it is READ from
// confirmed rows by src/allowance. Legacy-import addresses (the 192) are
// observed like any other; their history is not an allowance because the
// cutover import records nothing under `deposits` for what came before.
import { Prisma, type Chain } from "@prisma/client";
import { prisma } from "@/db/client.js";
import { appendAudit } from "@/audit/append.js";
import { enqueue } from "@/webhooks/dispatch.js";
import type { ChainObserver, ObservedTransfer } from "@/chain/types.js";

export const CONFIRMATIONS_REQUIRED: Record<Chain, number> = { BEP20: 15, TRC20: 19 }; // SamaPrime's mainnet defaults

export interface ObserveResult { seen: number; recorded: number; alreadyKnown: number; confirmed: number; unknownAddress: number }

/** One tick for one chain. Safe to call again with the same transfers: nothing double-writes. */
export async function observeChain(chain: Chain, observer: ChainObserver): Promise<ObserveResult> {
  const addresses = await prisma.address.findMany({ where: { chain }, select: { id: true, address: true, keyId: true } });
  const byAddress = new Map(addresses.map((a) => [a.address.toLowerCase(), a]));
  const transfers = await observer.scan(chain, new Set(byAddress.keys()));
  const result: ObserveResult = { seen: transfers.length, recorded: 0, alreadyKnown: 0, confirmed: 0, unknownAddress: 0 };
  for (const t of transfers) {
    const outcome = await recordTransfer(chain, t, byAddress.get(t.toAddress.toLowerCase()));
    result[outcome]++;
  }
  result.confirmed += await promoteConfirmed(chain, observer);
  return result;
}

async function recordTransfer(chain: Chain, t: ObservedTransfer, target: { id: string; keyId: string } | undefined): Promise<"recorded" | "alreadyKnown" | "unknownAddress"> {
  if (!target) return "unknownAddress";
  try {
    await prisma.$transaction(async (tx) => {
      const row = await tx.deposit.create({
        data: { keyId: target.keyId, addressId: target.id, chain, txHash: t.txHash, amount: new Prisma.Decimal(t.amount), confirmations: t.confirmations, status: "detected", blockNumber: t.blockNumber },
        select: { id: true },
      });
      await appendAudit(tx, { keyId: target.keyId, actor: "observer", action: "deposit.detected", subjectId: row.id, params: { chain, txHash: t.txHash, amount: t.amount, block: t.blockNumber.toString() } });
    });
    return "recorded";
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return "alreadyKnown"; // UNIQUE(chain, tx_hash): the structural one-credit rule
    throw e;
  }
}

/** detected → confirmed, once. The status guard in the WHERE is what makes "once" true under concurrency. */
async function promoteConfirmed(chain: Chain, observer: ChainObserver): Promise<number> {
  const pending = await prisma.deposit.findMany({ where: { chain, status: "detected" }, select: { id: true, keyId: true, txHash: true, amount: true, addressId: true } });
  let promoted = 0;
  for (const d of pending) {
    const confirmations = await observer.confirmationsFor(chain, d.txHash);
    if (confirmations < CONFIRMATIONS_REQUIRED[chain]) { await prisma.deposit.update({ where: { id: d.id }, data: { confirmations } }); continue; }
    await prisma.$transaction(async (tx) => {
      const flipped = await tx.deposit.updateMany({ where: { id: d.id, status: "detected" }, data: { status: "confirmed", confirmations, creditedAt: new Date() } });
      if (flipped.count !== 1) return; // someone else confirmed it first; nothing to do, nothing to audit twice
      promoted++;
      await appendAudit(tx, { keyId: d.keyId, actor: "observer", action: "deposit.confirmed", subjectId: d.id, params: { chain, txHash: d.txHash, amount: d.amount.toString(), confirmations } });
      const address = await tx.address.findUniqueOrThrow({ where: { id: d.addressId }, select: { reference: true } });
      await enqueue(d.keyId, "deposit.confirmed", `dep_${d.id}`, { deposit_id: d.id, reference: address.reference, chain, tx_hash: d.txHash, amount: d.amount.toString(), confirmations });
    });
  }
  return promoted;
}
