// Round-robin RPC pool with per-URL cooldown, shared by the BSC and Tron
// adapters. Public RPC endpoints (bsc-dataseed-class, TronGrid without a
// key) rate-limit under load — see retry.ts's header comment for the
// production incident this and withRpcRetry() both respond to. Where
// withRpcRetry() retries a single URL a few times with backoff,
// RpcPool rotates to a *different* URL once a given one looks
// rate-limited, so one endpoint's outage doesn't stall the scanner.
import { logger } from "@/log.js";
import { ChainRpcError } from "@/chain/impl/errors.js";
import { withRpcRetry } from "@/chain/impl/retry.js";
import type { Chain } from "@prisma/client";

const COOLDOWN_MS = 60_000;

// Not just literal rate-limiting: some free-tier public endpoints impose
// other request-shape quotas instead (observed live against
// bsc-mainnet.public.blastapi.io: it caps eth_getLogs to a 10-block
// range and returns a -32600 "up to a 10 block range" error rather than
// a 429/-32005). Functionally that's the same problem — this endpoint
// can't serve the request our maxBlockRange config expects — so it gets
// the same treatment: cool this URL down and rotate to the next one,
// rather than failing the whole scan tick.
function isRateLimitClassError(error: unknown): boolean {
  // NORMALISE HYPHENS BEFORE MATCHING. Found 2026-08-18 and it is the
  // reason the BEP20 scanner stalled for hours: blastapi returns
  // "Your request has been RATE-LIMITED due to unusually high traffic",
  // and this function looked for "rate limit" with a SPACE. It matched
  // nothing, so the pool did not cool that endpoint or rotate — it
  // rethrew, aborting the whole tick, including the chunks that would
  // have gone to the ONE endpoint that works.
  // A hyphen. Matching text instead of meaning, again.
  // *** BOTH FORMS, and the reason is a regression I caught in review of
  // this very change: normalising hyphens turns the JSON-RPC code
  // "-32005" into " 32005", so the `-32005` keyword below would have
  // STOPPED matching — trading one missed error class for another.
  // Match the raw text and the hyphen-normalised text; a keyword only
  // has to hit one of them.
  const raw = String(error).toLowerCase();
  const flat = raw.replace(/[-_]/g, " ");
  const message = { includes: (needle: string) => raw.includes(needle) || flat.includes(needle) };
  return (
    // *** AN ENDPOINT THAT DOES NOT IMPLEMENT THE METHOD AT ALL. ***
    // bsc.meowrpc.com answers every eth_getLogs with "The method
    // eth_getLogs is not supported." — a permanent capability gap, not a
    // transient failure. Unclassified, it killed the entire tick every
    // time the round robin handed it out. Rotating away is right: the
    // pool cannot fix an endpoint that will never serve this call, but
    // it can stop letting it take the tick down with it.
    message.includes("not supported") ||
    message.includes("method not found") ||
    message.includes("unsupported method") ||
    // Observed live from bsc-dataseed1.defibit.io alongside -32005.
    message.includes("limit exceeded") ||
    message.includes("rate limit") ||
    message.includes("429") ||
    message.includes("-32005") ||
    message.includes("archive") ||
    message.includes("503") ||
    message.includes("block range") ||
    // Defense-in-depth for an endpoint that doesn't implement a
    // REST route the pool expects (e.g. a non-TronGrid Tron gateway
    // mixed into an events-only URL list) — rotate away from it rather
    // than hard-failing the whole tick. The real fix for the known case
    // is keeping getTronEventsRpcUrls() TronGrid-only (config.ts); this
    // is a safety net for any future misconfiguration, not the primary
    // fix.
    message.includes("404") ||
    // Observed live 2026-08-10: 502 from a public endpoint sitting behind
    // a reverse proxy that's unhealthy/overloaded (distinct from the node
    // itself returning a JSON-RPC error) — same "this endpoint can't serve
    // us right now" bucket as 503/429, rotate away from it.
    message.includes("502") ||
    message.includes("bad gateway") ||
    // Observed live 2026-08-10: after withRpcRetry (retry.ts) exhausts its
    // 3 same-URL retries on a timeout and rethrows, the error still
    // reaches here — without this, a persistently slow/unreachable
    // endpoint crashes the whole scan tick instead of the pool rotating
    // to a healthier one. withRpcRetry already retries a *transient*
    // timeout against the same URL first; this is the fallback once that
    // URL has proven itself consistently too slow.
    message.includes("timeout") ||
    message.includes("timed out")
  );
}

interface UrlState {
  readonly url: string;
  coolingUntil: number; // epoch ms; 0 means not cooling
}

/**
 * Generic client pool: `TClient` is whatever per-URL client object the
 * caller needs (an ethers.JsonRpcProvider for BSC, a TronWeb instance for
 * Tron). Clients are created once per URL and cached forever — never
 * recreated per call, which is what avoids the EventEmitter
 * MaxListenersExceededWarning a naive "new provider every request"
 * implementation would trigger under the scanner's polling interval.
 */
export class RpcPool<TClient> {
  private readonly states: UrlState[];
  private readonly clients = new Map<string, TClient>();
  private cursor = 0;

  constructor(
    private readonly chain: Chain,
    urls: readonly string[],
    private readonly makeClient: (url: string) => TClient,
  ) {
    if (urls.length === 0) {
      throw new ChainRpcError(chain, new Error(`No RPC URLs configured for ${chain}`));
    }
    this.states = urls.map((url) => ({ url, coolingUntil: 0 }));
  }

  private clientFor(url: string): TClient {
    let client = this.clients.get(url);
    if (!client) {
      client = this.makeClient(url);
      this.clients.set(url, client);
    }
    return client;
  }

  /** Next non-cooling URL in round-robin order, or null if every URL is cooling. */
  private nextAvailable(): UrlState | null {
    const now = Date.now();
    for (let i = 0; i < this.states.length; i++) {
      const idx = (this.cursor + i) % this.states.length;
      const state = this.states[idx];
      // Unreachable: idx is (cursor + i) % states.length. Written as a skip
      // rather than a `!` so an empty pool degrades to "none available"
      // instead of throwing a TypeError inside the scanner's hot path.
      if (!state) continue;
      if (state.coolingUntil <= now) {
        this.cursor = (idx + 1) % this.states.length;
        return state;
      }
    }
    return null;
  }

  /**
   * Runs `fn` against the next available URL's client. `fn` itself should
   * be a single logical RPC operation (already free to use withRpcRetry
   * internally for that one URL's transient failures). If `fn` throws a
   * rate-limit-class error, this URL is put on a 60s cooldown and the
   * next available URL is tried; a non-rate-limit error is NOT retried
   * against another URL (it's presumed to be a real error — e.g. a bad
   * contract call — not an endpoint health problem), and is thrown
   * immediately. Throws `ChainRpcError` if every URL is currently
   * cooling or every URL's attempt failed with a rate-limit error.
   */
  async run<T>(fn: (client: TClient, url: string) => Promise<T>): Promise<T> {
    const attempted: string[] = [];

    for (let i = 0; i < this.states.length; i++) {
      const state = this.nextAvailable();
      if (!state) break;
      attempted.push(state.url);

      try {
        const result = await fn(this.clientFor(state.url), state.url);
        logger.info({ chain: this.chain, rpcUrl: state.url }, "Crypto RPC call succeeded");
        return result;
      } catch (error) {
        if (isRateLimitClassError(error)) {
          state.coolingUntil = Date.now() + COOLDOWN_MS;
          logger.warn(
            { chain: this.chain, rpcUrl: state.url, err: error, cooldownMs: COOLDOWN_MS },
            "Crypto RPC call rate-limited, rotating to next endpoint",
          );
          continue;
        }
        throw error;
      }
    }

    throw new ChainRpcError(
      this.chain,
      new Error(
        `All ${this.states.length} configured RPC endpoint(s) for ${this.chain} are cooling down or unreachable ` +
          `(tried: ${attempted.length ? attempted.join(", ") : "none — all already cooling"}). ` +
          `Add more endpoints via CRYPTO_${this.chain === "BEP20" ? "BSC" : "TRON"}_MAINNET_RPCS or wait ${COOLDOWN_MS / 1000}s for cooldown to clear.`,
      ),
    );
  }

  /** Convenience: run() wrapped in withRpcRetry for the per-URL attempt, matching the existing adapter convention. */
  async runWithRetry<T>(fn: (client: TClient, url: string) => Promise<T>): Promise<T> {
    return this.run((client, url) => withRpcRetry(() => fn(client, url)));
  }

  /**
   * Exactly ONE attempt against ONE URL — no rotation on a rate-limit-class
   * error, no retry, no fallback to a second endpoint. Every other method
   * on this class exists specifically to make READS resilient (retry a
   * flaky endpoint, rotate away from a rate-limited one) — both of those
   * behaviors are actively dangerous for a non-idempotent blockchain WRITE
   * (broadcasting a signed transaction), since an "ambiguous" failure
   * (timeout waiting for the RPC response) doesn't tell you whether the
   * node already accepted the transaction. Rotating to a different
   * endpoint and trying again in that situation can broadcast a second,
   * genuinely independent transaction — this is the exact mechanism
   * behind the 2026-08-10 duplicate-withdrawal incident (see
   * docs/INVARIANTS.md). Every broadcast call site (withdraw-sender.ts,
   * admin-hot-wallet-sender.ts, auto-sweeper.ts) must use this, never
   * run()/runWithRetry(), for the actual send step.
   */
  async runOnce<T>(fn: (client: TClient, url: string) => Promise<T>): Promise<T> {
    // ⚠️ `?? this.states[0]` is undefined when the pool is EMPTY, and the old
    // code then threw a bare TypeError on `.url` — inside a SEND. Refuse by
    // name instead: an empty pool is a configuration fault, not a chain fault,
    // and the two must not be reported as the same thing.
    const state = this.nextAvailable() ?? this.states[0];
    if (!state) throw new Error("rpc pool is empty: no endpoint configured for this chain");
    return fn(this.clientFor(state.url), state.url);
  }
}
