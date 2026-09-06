import { TronWeb } from "tronweb";
import { getChainConfig, getTronEventsRpcUrls, type CryptoNetworkMode } from "@/chain/impl/config.js";
import { ChainRpcError } from "@/chain/impl/errors.js";
import { withRpcRetry } from "@/chain/impl/retry.js";
import { RpcPool } from "@/chain/impl/rpc-pool.js";
import { logger } from "@/log.js";
import type { ChainAdapter, IncomingTransfer, IncomingTransferScan } from "@/chain/impl/index.js";

interface TronGridEvent {
  transaction_id: string;
  block_number: number;
  event_name: string;
  result: { from: string; to: string; value: string };
}

interface TronGridEventsResponse {
  success: boolean;
  data: TronGridEvent[];
  meta?: { links?: { next?: string } };
}

/** One row of `/v1/accounts/<addr>/transactions/trc20` — a different endpoint and a different shape from the contract-events one above. */
interface TronGridTrc20Transfer {
  transaction_id: string;
  block_timestamp: number;
  from: string;
  to: string;
  value: string;
  type?: string;
  token_info?: { address?: string; decimals?: number };
}

interface TronGridTrc20Response {
  success: boolean;
  data: TronGridTrc20Transfer[];
  meta?: { links?: { next?: string } };
}

const MAX_EVENT_PAGES = 20;

/** Gap between per-address TronGrid calls. Overridable so a key-holding deployment can lower it. */
const ADDRESS_PACING_MS = Math.max(0, Number(process.env.CRYPTO_TRON_ADDRESS_PACING_MS ?? 250));

class TronAdapter implements ChainAdapter {
  readonly chain = "TRC20" as const;

  // Lazily built — getChainConfig() throws if required env is missing,
  // so this must not run at module load time.
  private _pool: RpcPool<TronWeb> | null = null;
  // Separate pool for the TronGrid-only `/v1/contracts/.../events` REST
  // call — see getTronEventsRpcUrls()'s header comment in config.ts for
  // why this can't share `pool` above (which includes publicnode, a
  // non-TronGrid gateway that 404s on this endpoint).
  private _eventsPool: RpcPool<string> | null = null;

  private get pool(): RpcPool<TronWeb> {
    if (!this._pool) {
      const config = getChainConfig("TRC20");
      // One TronWeb instance per RPC URL, cached forever — never
      // recreated per call, same rationale as the BSC adapter's pool.
      this._pool = new RpcPool<TronWeb>("TRC20", config.rpcUrls, (url) => new TronWeb({ fullHost: url }));
    }
    return this._pool;
  }

  private get eventsPool(): RpcPool<string> {
    if (!this._eventsPool) {
      this._eventsPool = new RpcPool<string>("TRC20", getTronEventsRpcUrls(), (url) => url);
    }
    return this._eventsPool;
  }

  get network(): CryptoNetworkMode {
    return getChainConfig("TRC20").network;
  }

  get tokenDecimals(): number {
    return getChainConfig("TRC20").tokenDecimals;
  }

  async getLatestBlock(): Promise<bigint> {
    try {
      const block = await this.pool.runWithRetry((client) => client.trx.getCurrentBlock());
      return BigInt(block.block_header.raw_data.number);
    } catch (cause) {
      throw new ChainRpcError("TRC20", cause);
    }
  }

  private async getBlockTimestamp(client: TronWeb, blockNumber: bigint): Promise<number> {
    const block = await withRpcRetry(() => client.trx.getBlockByNumber(Number(blockNumber)));
    return block.block_header.raw_data.timestamp;
  }

  private async fetchEventsPage(url: string): Promise<TronGridEventsResponse> {
    // ==================================================================
    // *** THE TRONGRID API KEY — the single highest-value config change
    // available to this module, and it is FREE. ***
    // ==================================================================
    // TRC20 deposit detection runs on ONE TronGrid endpoint with no
    // fallback and no partial-progress recovery (TronGrid paginates
    // DESCENDING, so a partial fetch holds the wrong end of the window
    // for a forward cursor). Anonymous access is rate-limited hard
    // enough that a 429 stops detection completely — it did exactly
    // that for 45 minutes on 2026-08-18.
    //
    // A free key from trongrid.io raises that limit substantially. Set
    // TRONGRID_API_KEY and it is sent automatically; leave it unset and
    // behaviour is byte-identical to before, so this cannot break an
    // environment that has no key.
    const apiKey = process.env.TRONGRID_API_KEY;
    const res = await fetch(url, apiKey ? { headers: { "TRON-PRO-API-KEY": apiKey } } : undefined);
    if (!res.ok) {
      // fetch() only rejects on network failure, not HTTP error status —
      // throw explicitly so withRpcRetry/RpcPool can see and react to a
      // 429 (TronGrid's actual observed failure mode).
      throw new Error(`TronGrid events request failed: ${res.status}`);
    }
    const body = (await res.json()) as TronGridEventsResponse;
    if (!body.success) {
      throw new Error("TronGrid events request returned success:false");
    }
    return body;
  }

  /** Same auth and error handling as fetchEventsPage — a DIFFERENT endpoint with a different response shape, so it gets its own typed reader rather than a cast. */
  private async fetchTrc20Page(url: string): Promise<TronGridTrc20Response> {
    const apiKey = process.env.TRONGRID_API_KEY;
    const res = await fetch(url, apiKey ? { headers: { "TRON-PRO-API-KEY": apiKey } } : undefined);
    if (!res.ok) {
      // ==============================================================
      // *** A 429 WITH NO API KEY IS NOT A MYSTERY, SO DO NOT REPORT
      // IT AS ONE. ***
      // ==============================================================
      // MEASURED 2026-08-20 against anonymous TronGrid: request 1
      // returned 200 and requests 2 through 12 returned 429. The
      // anonymous budget is roughly ONE REQUEST PER FEW SECONDS, and
      // this scanner needs one per address per tick.
      //
      // *** SO THE PER-ADDRESS SHAPE CANNOT RUN WITHOUT THE KEY, AND
      // NEITHER COULD THE OLD ONE — it was already 429-stalled for
      // seven hours before it was replaced. *** The difference is that
      // this shape works the moment a key exists; the old one would
      // still be paging the whole of Tron.
      //
      // The generic "RPC call failed" this used to raise sent whoever
      // read it looking for a bug. The remedy is a free key from
      // trongrid.io in TRONGRID_API_KEY, and the error now says so.
      if (res.status === 429 && !apiKey) {
        throw new Error(
          "TronGrid rate-limited this request (429) and TRONGRID_API_KEY IS NOT SET. " +
            "Anonymous TronGrid allows roughly one request every few seconds; TRC20 detection needs one per address per tick. " +
            "This is a MISSING CREDENTIAL, not a code fault — get a free key at https://www.trongrid.io/ and set TRONGRID_API_KEY.",
        );
      }
      throw new Error(`TronGrid trc20 request failed: ${res.status}`);
    }
    const body = (await res.json()) as TronGridTrc20Response;
    if (!body.success) throw new Error("TronGrid trc20 request returned success:false");
    return body;
  }

  // ====================================================================
  // *** TRON IS STILL ALL-OR-NOTHING — AND THE REASON CHANGED ON
  // 2026-08-19, SO READ THE NEW ONE. ***
  // ====================================================================
  // THE ORIGINAL REASON, now only half true: this queried a TIMESTAMP
  // window and paged a cursor, and a page boundary is not a block
  // boundary, so a partial `scannedThrough` would be a GUESS — and the
  // failure mode of guessing is a cursor moving past a block whose
  // events were never read. A stall is recoverable; that is not.
  //
  // WHAT CHANGED. This no longer pages the whole USDT contract's event
  // stream. It asks, PER ADDRESS, for that address's own TRC20
  // transfers. Two of the old constraints genuinely dissolved:
  //
  //   - **DESCENDING ORDER IS GONE.** `order_by=block_timestamp,asc` is
  //     supported and verified live, so pages now arrive oldest-first.
  //   - **THE WINDOW IS NATURALLY BOUNDED.** With min/max timestamps and
  //     20 addresses the result set is tiny, and an empty window returns
  //     no `links.next` at all — pagination terminates instead of
  //     running to MAX_EVENT_PAGES against the whole of Tron.
  //
  // *** BUT ALL-OR-NOTHING IS STILL CORRECT, FOR A DIFFERENT REASON,
  // AND THIS IS THE PART THAT WOULD BE EASY TO GET WRONG. *** Coverage
  // of a window is only complete once EVERY address has been asked. If
  // address 7 of 20 fails, addresses 8-20 were never checked for that
  // window — and "we finished 6 addresses" is not a block boundary
  // either. Banking partial progress here would skip deposits to the
  // addresses we never reached.
  //
  // So the stance is unchanged and the cost of it collapsed: it used to
  // mean a tick that could never complete, and now it means ~20 small
  // calls that do.
  async getIncomingTransfers(fromBlock: bigint, toBlock: bigint, addresses: Set<string>): Promise<IncomingTransferScan> {
    if (addresses.size === 0) return { transfers: [], scannedThrough: toBlock };
    const normalized = new Set([...addresses].map((a) => TronWeb.address.toHex(a)));
    const config = getChainConfig("TRC20");

    try {
      const { minTimestamp, maxTimestamp } = await this.pool.runWithRetry(async (client) => ({
        minTimestamp: await this.getBlockTimestamp(client, fromBlock),
        maxTimestamp: await this.getBlockTimestamp(client, toBlock),
      }));

      const transfers = await this.eventsPool.runWithRetry(async (base) => {
        const collected: IncomingTransfer[] = [];

        // ============================================================
        // *** ONE REQUEST PER ADDRESS, NOT ONE PER CHAIN. ***
        // ============================================================
        // The old shape paged `/v1/contracts/<USDT>/events` — EVERY USDT
        // transfer on Tron, 200 at a time, discarding all but ours in
        // JavaScript. USDT on Tron is the busiest token contract in
        // existence, so MAX_EVENT_PAGES was reached long before our own
        // deposits appeared, and the rate limit did the rest.
        //
        // `/v1/accounts/<addr>/transactions/trc20` returns only that
        // address's transfers. 20 tiny calls instead of paging the
        // chain. Sequential on purpose — the same pacing reasoning as
        // BSC's chunk loop, against a single endpoint with no fallback.
        let addressIndex = 0;
        for (const addressHex of normalized) {
          // *** PACE THE CALLS. *** This loop turned one paginated
          // request into one per address, which is the whole point — but
          // it also turned a slow stream into a burst, and TronGrid
          // rate-limits on RATE, not on bytes. A short gap between
          // addresses costs a few seconds of a tick that nothing is
          // waiting on, and it is what keeps a 20-address sweep inside
          // even a modest budget once a key raises the ceiling.
          //
          // It does NOT rescue the anonymous case — that budget is far
          // too small for 20 calls at any pacing (see fetchTrc20Page).
          if (addressIndex++ > 0) await new Promise((resolve) => setTimeout(resolve, ADDRESS_PACING_MS));
          const address = TronWeb.address.fromHex(addressHex);
          let nextUrl: string | undefined =
            `${base}/v1/accounts/${address}/transactions/trc20` +
            `?contract_address=${config.usdtContract}` +
            `&only_confirmed=true&order_by=block_timestamp,asc` +
            `&min_timestamp=${minTimestamp}&max_timestamp=${maxTimestamp}&limit=200`;

          for (let page = 0; page < MAX_EVENT_PAGES && nextUrl; page++) {
            const body = await this.fetchTrc20Page(nextUrl);

            for (const row of body.data ?? []) {
              // `to` is what makes it a DEPOSIT. This endpoint returns
              // the address's transfers in BOTH directions, so without
              // this check an outgoing sweep would be credited as an
              // incoming deposit.
              if (TronWeb.address.toHex(row.to) !== addressHex) continue;
              // Defence in depth: `contract_address` already filters
              // server-side, and a wrong token here would mis-price a
              // deposit by whatever its decimals are.
              if (row.token_info?.address && row.token_info.address !== config.usdtContract) continue;

              collected.push({
                txHash: row.transaction_id,
                toAddress: address,
                amountRaw: row.value,
                // ⚠️ THIS ENDPOINT RETURNS NO block_number — verified
                // against a live response, whose only fields are
                // block_timestamp/from/to/token_info/transaction_id/
                // type/value. It is resolved per transfer below rather
                // than derived from the window, because a fabricated
                // block number feeds the confirmation count and the
                // reorg check, and both would then be reasoning about a
                // block the deposit was not in.
                blockNumber: BigInt(0),
              });
            }

            nextUrl = body.meta?.links?.next;
          }
        }

        return collected;
      });

      // ==============================================================
      // RESOLVE THE REAL BLOCK NUMBER — one call per DEPOSIT, and
      // deposits are rare (15 in this system's entire history), so this
      // is a handful of calls a year, not per tick.
      // ==============================================================
      // *** THE FALLBACK IS DELIBERATELY THE CONSERVATIVE DIRECTION. ***
      // If resolution fails we record `toBlock`, the TOP of the window
      // just scanned. That is >= the real block, so the confirmation
      // count comes out TOO LOW and the deposit waits LONGER before
      // crediting. The opposite error — a block number too low — would
      // over-count confirmations and credit real money early.
      //
      // Never drop the transfer instead: a deposit we cannot date is
      // still a deposit somebody sent.
      for (const transfer of transfers) {
        try {
          const info = await this.pool.runWithRetry((client) => client.trx.getTransactionInfo(transfer.txHash));
          if (info?.blockNumber) {
            transfer.blockNumber = BigInt(info.blockNumber);
            continue;
          }
          throw new Error("no blockNumber in transaction info");
        } catch (cause) {
          transfer.blockNumber = toBlock;
          logger.warn(
            { chain: "TRC20", txHash: transfer.txHash, fallbackBlock: toBlock.toString(), err: cause },
            "Could not resolve a TRC20 transfer's block number — recorded the top of the scanned window, which under-counts confirmations rather than over-counting them",
          );
        }
      }

      return { transfers, scannedThrough: toBlock };
    } catch (cause) {
      throw new ChainRpcError("TRC20", cause);
    }
  }

  async getConfirmations(txHash: string): Promise<number> {
    try {
      return await this.pool.runWithRetry(async (client) => {
        const info = await client.trx.getTransactionInfo(txHash);
        if (!info || !info.blockNumber) return 0;
        const latestBlock = await client.trx.getCurrentBlock();
        const latest = BigInt(latestBlock.block_header.raw_data.number);
        return Math.max(0, Number(latest) - info.blockNumber + 1);
      });
    } catch (cause) {
      throw new ChainRpcError("TRC20", cause);
    }
  }

  /** See BscAdapter#transactionExists's header comment — same reasoning, NOT part of the ChainAdapter interface. client.trx.getTransaction() (not getTransactionInfo, which is receipt-like and confirmation-only) returns the raw tx if the node knows about it at all. */
  async transactionExists(txHash: string): Promise<boolean> {
    try {
      return await this.pool.runWithRetry(async (client) => {
        const tx = await client.trx.getTransaction(txHash);
        return Boolean(tx && Object.keys(tx).length > 0);
      });
    } catch (cause) {
      throw new ChainRpcError("TRC20", cause);
    }
  }
}

export const tronAdapter = new TronAdapter();
