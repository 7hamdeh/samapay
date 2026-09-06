// Shared "broadcast a signed, state-changing transaction without risking a
// duplicate" primitives — see docs/INVARIANTS.md's 2026-08-10 entry for
// the incident this exists to fix: a customer withdrawal's internal
// retry loop treated an AMBIGUOUS failure (broadcast likely succeeded on
// the node, but something after that threw before our code learned the
// txHash) the same as a definite failure, retried the whole send, and a
// second, genuinely independent transaction went out — $10 left the hot
// wallet for what the ledger only ever recorded as one $5 withdrawal.
//
// Every broadcast call site in this codebase (lib/wallet/withdraw-sender.ts,
// lib/crypto/admin-hot-wallet-sender.ts, lib/crypto/sweep/auto-sweeper.ts)
// must go through one of the two functions below for its actual send
// step — never RpcPool.run()/runWithRetry() directly, which exist to make
// READS resilient (retry a flaky endpoint, rotate away from a rate-limited
// one) and are unsafe applied to a non-idempotent write for exactly the
// reason above.
import type { RpcPool } from "@/chain/impl/rpc-pool.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Structural, not `ethers.JsonRpcProvider` directly — this is the only
// method sendBep20WithPinnedNonce actually calls, and keeping the
// constraint minimal is what lets scripts/verify-broadcast-idempotency.ts
// exercise the real retry-safety contract against a fake in-memory
// "chain" instead of a live RPC endpoint.
interface NonceReadableProvider {
  getTransactionCount(address: string, blockTag?: string): Promise<number>;
}
interface BscClientWithProvider {
  provider: NonceReadableProvider;
}

/**
 * BEP20/BSC is nonce-based: two transactions signed with the SAME nonce
 * from the SAME sender can never both land — the network accepts at most
 * one (the second is rejected as "nonce too low" / "already known", or
 * treated as a replacement if it never actually landed). Fetching the
 * nonce ONCE before any attempt and reusing it on every retry makes the
 * retry loop safe at the protocol level, regardless of how ambiguous the
 * failure that triggered the retry was — this is the actual fix, not
 * just better error classification.
 *
 * `buildAndSend` receives the pinned nonce and must pass it through as
 * the transaction's explicit `nonce` override (e.g.
 * `contract.transfer(to, amount, { nonce })`) — the caller owns
 * constructing the right call, this helper only owns the retry-safety
 * contract around it.
 */
export async function sendBep20WithPinnedNonce<TPool extends BscClientWithProvider>(
  pool: RpcPool<TPool>,
  senderAddress: string,
  buildAndSend: (client: TPool, nonce: number) => Promise<{ hash: string }>,
  maxRetries: number,
): Promise<string> {
  // Reading the nonce is a safe, idempotent operation — the existing
  // retry/rotation machinery is fine here, unlike for the send itself.
  const nonce = await pool.runWithRetry(({ provider }) => provider.getTransactionCount(senderAddress, "pending"));

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // runOnce, not run/runWithRetry — see rpc-pool.ts's own doc comment.
      // Safety here comes from the pinned nonce above, not from avoiding
      // retry entirely; each attempt is still exactly one dispatch.
      const tx = await pool.runOnce((client) => buildAndSend(client, nonce));
      return tx.hash;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) await delay(2 ** attempt * 1000);
    }
  }
  throw lastError;
}

/**
 * TRC20/Tron has no nonce concept — a signed transaction's identity comes
 * from ref-block/expiration/timestamp fields that TronWeb's high-level
 * `contract().at().method().send()` regenerates fresh on every call.
 * Unlike BEP20, retrying the whole send after an ambiguous failure is NOT
 * protocol-safe here: a second signed transaction is genuinely
 * independent and can both land. So this is deliberately single-attempt
 * only, with zero retry of the broadcast step — a caller wanting
 * resilience should surface the failure for a human to decide (the admin
 * Retry button re-invokes this fresh, itself still single-attempt) rather
 * than auto-retry.
 */
export async function sendTrc20Once<T, TClient>(pool: RpcPool<TClient>, fn: (client: TClient) => Promise<T>): Promise<T> {
  return pool.runOnce((client) => fn(client));
}
