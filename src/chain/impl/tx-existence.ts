// "Does this tx exist on-chain at all — pending or mined" — the
// primitive the idempotency engine's stale-lock verification hook needs
// (docs/design/phase-2-withdrawal-idempotency.md §3). Deliberately NOT
// added to the shared ChainAdapter interface (lib/crypto/chains/index.ts)
// — every other caller of that interface (the deposit scanner, the
// withdrawal confirmation poller) doesn't need this distinction and
// shouldn't have to know it exists. Instead this is a thin dispatcher
// over a new method on each concrete adapter CLASS (bscAdapter.
// transactionExists / tronAdapter.transactionExists) — those reuse each
// adapter's own private, already-singleton RpcPool (one ethers
// JsonRpcProvider / TronWeb instance per URL, cached forever) rather
// than standing up a second pool for the same URLs, which would violate
// CLAUDE.md's "no new ethers Provider instances — singletons only".
import type { Chain } from "@prisma/client";
import { bscAdapter } from "@/chain/impl/bsc.js";
import { tronAdapter } from "@/chain/impl/tron.js";

export async function transactionExistsOnChain(chain: Chain, txHash: string): Promise<boolean> {
  return chain === "BEP20" ? bscAdapter.transactionExists(txHash) : tronAdapter.transactionExists(txHash);
}
