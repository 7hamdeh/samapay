import { ethers } from "ethers";
import { getChainConfig, type CryptoNetworkMode } from "@/chain/impl/config.js";
import { ChainRpcError } from "@/chain/impl/errors.js";
import { RpcPool } from "@/chain/impl/rpc-pool.js";
import type { ChainAdapter, IncomingTransfer, IncomingTransferScan } from "@/chain/impl/index.js";

const USDT_ABI = ["event Transfer(address indexed from, address indexed to, uint256 value)"];

/**
 * *** HOW MANY ADDRESSES GO INTO ONE `eth_getLogs` TOPIC ARRAY. ***
 *
 * The scanner passes EVERY address for the chain — `findMany({ where:
 * { chain } })`, unbounded, and this system mints one per user. Today
 * that is 20. At a thousand users it is a thousand-entry topic array in
 * a single JSON-RPC request, and providers cap request size.
 *
 * **THAT WOULD FAIL AS A STALL, NOT A LOSS** — the chunk errors, partial
 * progress banks what completed, and the scanner stops advancing. Which
 * is precisely the outage this whole change is fixing, arriving again
 * later by a different route and looking like a new problem.
 *
 * So the address list is batched. At 20 addresses this is ONE batch and
 * behaviour is identical to not batching at all; the code only starts
 * doing anything the day it is needed, which is the day nobody would be
 * watching for it.
 *
 * 100 is deliberately conservative — a topic array of 100 is small for
 * every provider, and the cost of an extra batch is one more call
 * against a filter that returns almost nothing.
 */
const ADDRESS_BATCH_SIZE = Math.max(1, Number(process.env.CRYPTO_BSC_ADDRESS_BATCH_SIZE ?? 100));

/** Exported for scripts/verify-chain-log-filter.ts — batching that is never exercised above one batch is not batching. */
export function batchAddresses(addresses: string[], size = ADDRESS_BATCH_SIZE): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < addresses.length; i += size) batches.push(addresses.slice(i, i + size));
  return batches;
}

interface BscClient {
  readonly provider: ethers.JsonRpcProvider;
  readonly contract: ethers.Contract;
}

class BscAdapter implements ChainAdapter {
  readonly chain = "BEP20" as const;

  // Lazily built — getChainConfig() throws if required env is missing,
  // so this must not run at module load time.
  private _pool: RpcPool<BscClient> | null = null;

  private get pool(): RpcPool<BscClient> {
    if (!this._pool) {
      const config = getChainConfig("BEP20");
      // One provider + contract instance per RPC URL, cached forever —
      // never recreated per call, which is what avoids an
      // EventEmitter MaxListenersExceededWarning under the scanner's
      // polling interval.
      this._pool = new RpcPool<BscClient>("BEP20", config.rpcUrls, (url) => {
        const provider = new ethers.JsonRpcProvider(url);
        const contract = new ethers.Contract(config.usdtContract, USDT_ABI, provider);
        return { provider, contract };
      });
    }
    return this._pool;
  }

  get network(): CryptoNetworkMode {
    return getChainConfig("BEP20").network;
  }

  get tokenDecimals(): number {
    return getChainConfig("BEP20").tokenDecimals;
  }

  async getLatestBlock(): Promise<bigint> {
    try {
      const latest = await this.pool.runWithRetry(({ provider }) => provider.getBlockNumber());
      return BigInt(latest);
    } catch (cause) {
      throw new ChainRpcError("BEP20", cause);
    }
  }

  async getIncomingTransfers(fromBlock: bigint, toBlock: bigint, addresses: Set<string>): Promise<IncomingTransferScan> {
    if (addresses.size === 0) return { transfers: [], scannedThrough: toBlock };
    const normalized = new Set([...addresses].map((a) => a.toLowerCase()));
    const { eventChunkSize } = getChainConfig("BEP20");

    // ==================================================================
    // *** PARTIAL PROGRESS SURVIVES A FAILED CHUNK. ***
    // ==================================================================
    // Before 2026-08-18 this method wrapped the whole chunk loop in one
    // try/catch and threw on the first failure, discarding every chunk
    // that had already succeeded. With a 300-block range split into
    // 10-block chunks, ONE rate-limited call in thirty threw away the
    // other twenty-nine — and because the scanner only advances its
    // cursor on a clean return, the identical 300-block request was
    // reissued 15 seconds later, forever. The scanner sat 4,728 blocks
    // behind for hours on exactly this loop.
    //
    // Now each completed chunk is banked. `scannedThrough` moves only
    // after a chunk's events have been collected, so the caller can
    // advance its cursor to it without ever skipping an unscanned
    // block — which is the one property that must not be traded away
    // for liveness.
    const transfers: IncomingTransfer[] = [];
    let scannedThrough = fromBlock - BigInt(1);
    let stoppedEarly: { atBlock: bigint; reason: string } | undefined;

    try {
      // Sequential, bounded-width chunks — see ChainConfig.eventChunkSize's
      // header comment. Every free-tier endpoint currently configured
      // rejects a single eth_getLogs call spanning more than 10-25 blocks
      // outright (not a rate limit — a hard request-shape error), so a
      // wide [fromBlock, toBlock] range from the scanner must be split
      // into multiple narrow calls, not requested in one shot. Sequential
      // (not Promise.all) deliberately paces requests against the same
      // rate-limited endpoints rather than bursting them in parallel.
      for (let chunkStart = fromBlock; chunkStart <= toBlock; chunkStart += BigInt(eventChunkSize)) {
        const chunkEnd = chunkStart + BigInt(eventChunkSize) - BigInt(1) > toBlock ? toBlock : chunkStart + BigInt(eventChunkSize) - BigInt(1);

        let events;
        try {
          events = await this.pool.runWithRetry(({ contract }) => {
            // ============================================================
            // *** THE RECIPIENT FILTER. WITHOUT IT THIS CALL ASKS FOR
            // EVERY USDT TRANSFER ON BSC. ***
            // ============================================================
            // `contract.filters.Transfer()` with no arguments matches the
            // contract and the event topic only. USDT is the busiest
            // contract on the chain, so that is hundreds of logs per
            // block — and every public endpoint refuses it. MEASURED
            // 2026-08-19 on bsc.rpc.blxrbdn.com: unfiltered fails at ONE
            // block; filtered succeeds over 5,000.
            //
            // `to` is an INDEXED parameter, so passing an array makes the
            // node do the OR-match in its own index instead of shipping
            // us the whole chain to filter in JavaScript. Verified live
            // with a 20-address array; batched above 100 so a growing
            // user base cannot silently outgrow a request size limit.
            //
            // ⚠️ THE JS CHECK BELOW STAYS. It can only ever REMOVE rows,
            // so it cannot mask a filter that is too narrow — that is
            // what the two-known-deposit control in
            // scripts/verify-chain-log-filter.ts exists for. What it DOES
            // guarantee is that a node ignoring or mis-applying the topic
            // filter can never make us credit somebody else's transfer.
            // ethers types the generated filter as possibly-undefined. If the
            // ABI ever stops carrying Transfer, refuse by name rather than
            // invoking undefined mid-scan.
            const transferFilter = contract.filters.Transfer;
            if (!transferFilter) throw new Error("BEP20 USDT ABI exposes no Transfer event filter");
            return Promise.all(
              batchAddresses([...normalized]).map((batch) => contract.queryFilter(transferFilter(null, batch), chunkStart, chunkEnd)),
            ).then((results) => results.flat());
          });
        } catch (cause) {
          // STOP HERE, KEEP WHAT WE HAVE. Continuing past a failed chunk
          // would mean reporting later blocks as scanned while this one
          // never was — the exact way a deposit disappears. Breaking
          // leaves `scannedThrough` at the last chunk that genuinely
          // completed, and the next tick resumes from there.
          if (scannedThrough < fromBlock) throw cause; // got nowhere: behave exactly as before
          stoppedEarly = { atBlock: chunkStart, reason: cause instanceof Error ? cause.message.slice(0, 200) : String(cause).slice(0, 200) };
          break;
        }

        for (const event of events) {
          if (!("args" in event) || !event.args) continue;
          const to = (event.args.to as string).toLowerCase();
          if (!normalized.has(to)) continue;
          transfers.push({
            txHash: event.transactionHash,
            toAddress: to,
            amountRaw: (event.args.value as bigint).toString(),
            blockNumber: BigInt(event.blockNumber),
          });
        }
        scannedThrough = chunkEnd;
      }
      // exactOptionalPropertyTypes: an OPTIONAL property may be absent, but may
      // not be present-and-undefined. Spread it only when it happened.
      return { transfers, scannedThrough, ...(stoppedEarly ? { stoppedEarly } : {}) };
    } catch (cause) {
      throw new ChainRpcError("BEP20", cause);
    }
  }

  async getConfirmations(txHash: string): Promise<number> {
    try {
      return await this.pool.runWithRetry(async ({ provider }) => {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt || receipt.blockNumber == null) return 0;
        const latest = await provider.getBlockNumber();
        return Math.max(0, latest - receipt.blockNumber + 1);
      });
    } catch (cause) {
      throw new ChainRpcError("BEP20", cause);
    }
  }

  /**
   * NOT part of the ChainAdapter interface — a narrower, single-purpose
   * capability only the idempotency engine's stale-lock on-chain
   * verification hook needs (lib/wallet/withdrawal-recovery.ts, Phase 2).
   * Deliberately distinct from getConfirmations(): that only resolves
   * once a tx is MINED (provider.getTransactionReceipt returns null for
   * both "still pending in the mempool" and "never broadcast at all" —
   * see docs/design/phase-2-withdrawal-idempotency.md §3 for the full
   * finding). provider.getTransaction() returns non-null the instant the
   * node knows about the tx at all, pending or mined — the correct
   * primitive for "was this ever broadcast."
   */
  async transactionExists(txHash: string): Promise<boolean> {
    try {
      return await this.pool.runWithRetry(async ({ provider }) => (await provider.getTransaction(txHash)) !== null);
    } catch (cause) {
      throw new ChainRpcError("BEP20", cause);
    }
  }
}

export const bscAdapter = new BscAdapter();
