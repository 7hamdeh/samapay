import type { Chain } from "@prisma/client";
import type { CryptoNetworkMode } from "@/chain/impl/config.js";

export interface IncomingTransfer {
  txHash: string;
  toAddress: string;
  /** Native token amount in the token's smallest unit (pre-decimals), as a string. */
  amountRaw: string;
  blockNumber: bigint;
}

/**
 * The outcome of one scan request: what was found, AND how far the scan
 * actually reached.
 */
export interface IncomingTransferScan {
  transfers: IncomingTransfer[];
  /**
   * The last block FULLY scanned. Equals `toBlock` on a complete scan.
   * On a partial scan it is the end of the last completed chunk, and the
   * caller may safely advance its cursor to exactly this block.
   * `fromBlock - 1n` means nothing was scanned.
   */
  scannedThrough: bigint;
  /** Present when the scan stopped before `toBlock`. Informational; the caller keeps the partial progress. */
  stoppedEarly?: { atBlock: bigint; reason: string };
}

export interface ChainAdapter {
  readonly chain: Chain;
  readonly network: CryptoNetworkMode;
  /** decimals() of the configured USDT/USDT-like token contract for this chain+network. */
  readonly tokenDecimals: number;

  getLatestBlock(): Promise<bigint>;

  /**
   * USDT Transfer events in [fromBlock, toBlock] whose recipient is in
   * `addresses`. `addresses` entries must be pre-normalized by the caller
   * (checksum/case handling is chain-specific — see each adapter).
   *
   * *** RETURNS HOW FAR IT ACTUALLY GOT, NOT JUST WHAT IT FOUND. ***
   * Changed 2026-08-18 after the scanner sat stuck for hours: a chain
   * whose scan is split into many small RPC calls used to throw away
   * EVERY completed call the moment one of them failed, so the cursor
   * never advanced and the identical request was reissued forever. See
   * `IncomingTransferScan.scannedThrough`.
   *
   * CONTRACT: an implementation may return `scannedThrough < toBlock`,
   * but every block in `[fromBlock, scannedThrough]` MUST have been
   * fully scanned and its transfers included. Reporting a block as
   * scanned when it was not is how a deposit gets skipped forever —
   * that is worse than the stall this change fixes.
   *
   * It still THROWS when it got nowhere at all (no chunk completed), so
   * a total outage stays as loud as it was before.
   */
  getIncomingTransfers(fromBlock: bigint, toBlock: bigint, addresses: Set<string>): Promise<IncomingTransferScan>;

  getConfirmations(txHash: string): Promise<number>;
}

// Address derivation (lib/crypto/hd/derive.ts) is deliberately NOT part of
// this interface — it's pure local computation with no network dependency,
// unlike every other method here which talks to an RPC. Keeping it out
// avoids implying chain adapters need network access to derive an address.

import { bscAdapter } from "@/chain/impl/bsc.js";
import { tronAdapter } from "@/chain/impl/tron.js";

export function getChainAdapter(chain: Chain): ChainAdapter {
  return chain === "BEP20" ? bscAdapter : tronAdapter;
}
