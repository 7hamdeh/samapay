// Shared retry/backoff for chain RPC calls. Public testnet/mainnet RPC
// endpoints (bsc-dataseed.binance.org, api.trongrid.io without an API key,
// etc.) rate-limit aggressively — this is the actual, observed failure mode
// in production logs (HTTP 429 from TronGrid, JSON-RPC -32005 "triggered
// rate limit" from BSC), not a code bug in the request itself. Retrying
// with backoff is the correct response; giving up immediately (the
// original behavior) is what caused scanChainOnce to never advance its
// cursor on a rate-limited tick, which in turn made subsequent ticks
// request an ever-larger block range — see scanner.ts's MAX_BLOCK_RANGE
// cap for the other half of this fix.
function isRetryableRpcError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return (
    message.includes("rate limit") ||
    message.includes("429") ||
    message.includes("-32005") ||
    message.includes("503") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    // Observed live with the multi-RPC pool (lib/crypto/chains/rpc-pool.ts):
    // getLatestBlock() and a later eth_getLogs call can land on two
    // different physical nodes behind the same round-robin pool, and one
    // can be a block or two behind the other's view of chain tip —
    // "block N is beyond the latest block M of this node, retry later".
    // Self-resolving within a second or two as the lagging node catches
    // up; retrying the SAME url after a short backoff is the correct
    // response, not rotating to a different endpoint (see rpc-pool.ts,
    // which only rotates on genuine endpoint-level quota/rate errors).
    message.includes("beyond the latest block") ||
    message.includes("retry later")
  );
}

export async function withRpcRetry<T>(fn: () => Promise<T>, retries = 3, baseDelayMs = 500): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === retries || !isRetryableRpcError(error)) {
        throw error;
      }
      const delay = baseDelayMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
