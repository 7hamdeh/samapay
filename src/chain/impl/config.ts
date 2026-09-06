import { logger } from "@/log.js";
import { ConfigInvalidError, InvalidEncryptionKeyError } from "@/chain/impl/errors.js";
import type { Chain } from "@prisma/client";

export type CryptoNetworkMode = "testnet" | "mainnet";

export interface ChainConfig {
  readonly chain: Chain;
  readonly network: CryptoNetworkMode;
  /**
   * Every configured RPC endpoint for this chain+network, in priority
   * order. On mainnet this can be multiple URLs — see
   * lib/crypto/chains/rpc-pool.ts, which round-robins across them and
   * cools down any URL that returns a rate-limit-class error, so one
   * public endpoint's rate limit doesn't stall the scanner. Always at
   * least one entry.
   */
  readonly rpcUrls: readonly string[];
  /** First entry of `rpcUrls` — for callers that only ever want one URL (manual scripts, not the scanner). */
  readonly rpcUrl: string;
  /** USDT (or USDT-like test token) contract address for this chain+network. */
  readonly usdtContract: string;
  /**
   * ERC20/TRC20 `decimals()` for the configured token. This is NOT the same
   * across chains for real USDT: Binance-Peg USDT on BSC mainnet uses 18
   * decimals, while Tron mainnet USDT uses 6 — silently assuming 6 for both
   * (as a naive "USDT is always 6 decimals" implementation would) misprices
   * every BEP20 deposit by a factor of 10^12. Configurable per network
   * because testnet mock tokens can use arbitrary decimals.
   */
  readonly tokenDecimals: number;
  readonly confirmationsRequired: number;
  readonly scanIntervalMs: number;
  /**
   * Upper bound on blocks requested in a single getIncomingTransfers call.
   * Public RPC endpoints (bsc-dataseed.binance.org, TronGrid without an
   * API key) rate-limit large eth_getLogs/event-range queries. Capping
   * this also bounds how much a single failed-then-retried tick can
   * balloon the range by — see scanner.ts.
   */
  readonly maxBlockRange: number;
  /**
   * BEP20 only: upper bound on blocks requested in a SINGLE
   * eth_getLogs/queryFilter call. Free-tier public RPC endpoints reject a
   * wide range outright (observed live: meowrpc/blxrbdn cap at 25 blocks,
   * blastapi at 10) rather than rate-limiting it — a fundamentally
   * different constraint from maxBlockRange above, which only bounds how
   * far the scanner's cursor advances per TICK. lib/crypto/chains/bsc.ts
   * splits `[fromBlock, toBlock]` into sequential chunks of this size, so
   * one tick can still advance by the full maxBlockRange while never
   * making a single request wider than every configured endpoint allows.
   */
  readonly eventChunkSize: number;
  readonly explorerTxUrl: (txHash: string) => string;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new ConfigInvalidError(`${name} must be an integer, got "${raw}"`);
  }
  return parsed;
}

// ======================================================================
// *** THE CONFIRMATION FLOOR. The env var may RAISE it, never LOWER. ***
// ======================================================================
// `confirmationsRequired` is the number the confirmation checker compares
// against before it calls creditDeposit() (monitor/scanner.ts). Crediting
// is a ONE-WAY DOOR: it writes a wallet credit and a Transaction row, and
// nothing in this codebase reverses one. So this value is the entire
// distance between "a chain reorganisation rewrote history" and "a
// customer's balance is wrong and nobody can put it back".
//
// Until 2026-08-18 `envInt` honoured whatever it was given.
// CRYPTO_BSC_CONFIRMATIONS=1 would have been obeyed silently — one
// block deep, credited, irreversible — and nothing anywhere would have
// objected. Neither variable is set in production, so the defaults were
// in force and no deposit was ever at risk from this; the gap was that
// a typo, not a decision, was enough.
//
// REFUSED, NOT CLAMPED, and that is deliberate. A clamp leaves the
// operator believing a number the system is not using — they set 1, the
// system quietly uses 15, and the two only ever disagree in the
// operator's head. A refusal is loud at the moment of the mistake.
//
// WHY THESE NUMBERS: they are the mainnet defaults this module has
// always shipped, promoted from "default" to "minimum". BSC's 15 is the
// conventional exchange depth for the chain; Tron's 19 is one full
// super-representative round, which is where TRC20 treats a block as
// irreversible. Testnet is unaffected — it hardcodes 3 and never reads
// these variables at all (see getChainConfig).
export const MAINNET_CONFIRMATION_FLOOR: Record<Chain, number> = {
  BEP20: 15,
  TRC20: 19,
};

/**
 * First URL of a pool that must not be empty.
 * `rpcUrls[0]` is `string | undefined` under noUncheckedIndexedAccess, and an
 * empty pool is REACHABLE: resolveMainnetRpcUrls() reads env, so a misconfigured
 * CRYPTO_*_MAINNET_RPCS can yield []. Silently carrying `undefined` as the
 * primary URL would surface much later as an opaque fetch failure against the
 * money path; refuse here, naming the chain.
 */
function firstRpcUrl(urls: readonly string[], chain: Chain): string {
  const first = urls[0];
  if (first === undefined) throw new ConfigInvalidError(`no RPC endpoint configured for ${chain}`);
  return first;
}

/** Mainnet confirmation depth: the floor by default, raisable by env, never lowerable. */
function mainnetConfirmations(chain: Chain, varName: string): number {
  const floor = MAINNET_CONFIRMATION_FLOOR[chain];
  // Total over the Chain enum today, so unreachable — but this decides HOW MANY
  // CONFIRMATIONS before money is credited. A new chain added without a floor
  // must stop the process, never compare `configured < undefined` (always
  // false) and silently accept a depth of zero.
  if (floor === undefined) throw new ConfigInvalidError(`no mainnet confirmation floor is defined for ${chain}`);
  const configured = envInt(varName, floor);
  if (configured < floor) {
    throw new ConfigInvalidError(
      `${varName}=${configured} is below the ${chain} mainnet confirmation floor of ${floor}. ` +
        `A deposit credited that shallow can be undone by a routine chain reorganisation AFTER the wallet ` +
        `has been credited, and crediting is not reversible. Raise it to ${floor} or above, or unset the ` +
        `variable to use the default (${floor}).`,
    );
  }
  return configured;
}

function envRequired(name: string): string {
  const raw = process.env[name];
  if (!raw) {
    throw new ConfigInvalidError(`${name} is required when the crypto module is enabled`);
  }
  return raw;
}

/**
 * Resolves a mainnet chain's RPC endpoint list, in priority order:
 * 1. `${chain}_MAINNET_RPCS` — comma-separated list (current format).
 * 2. `${chain}_MAINNET_RPC` — single URL, deprecated but still read for
 *    backwards compat (a pino warning is logged once per resolution so
 *    an operator notices and migrates their `.env`).
 * 3. `defaults` — hardcoded public endpoints, used only if neither env
 *    var is set, so a fresh deploy still has multi-endpoint redundancy
 *    without any required config.
 */
function resolveMainnetRpcUrls(multiVarName: string, legacyVarName: string, defaults: readonly string[]): string[] {
  const multi = process.env[multiVarName];
  if (multi) {
    const urls = multi
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (urls.length > 0) return urls;
  }

  const legacy = process.env[legacyVarName];
  if (legacy) {
    logger.warn(
      { deprecatedEnvVar: legacyVarName, replacement: multiVarName },
      `${legacyVarName} is deprecated — set ${multiVarName} as a comma-separated list instead. Still honored as a single-URL fallback for now.`,
    );
    return [legacy];
  }

  return [...defaults];
}

const DEFAULT_BSC_MAINNET_RPCS = [
  "https://bsc.meowrpc.com",
  "https://bsc.rpc.blxrbdn.com",
  "https://bsc-mainnet.public.blastapi.io",
] as const;

const DEFAULT_TRON_MAINNET_RPCS = ["https://api.trongrid.io", "https://tron-rpc.publicnode.com"] as const;

export function isCryptoEnabled(): boolean {
  return process.env.CRYPTO_ENABLED === "true";
}

export function getCryptoNetworkMode(): CryptoNetworkMode {
  const raw = process.env.CRYPTO_MODE ?? "testnet";
  if (raw !== "testnet" && raw !== "mainnet") {
    throw new ConfigInvalidError(`CRYPTO_MODE must be "testnet" or "mainnet", got "${raw}"`);
  }
  return raw;
}

/** Base64-decodes and validates SEED_ENCRYPTION_KEY. Throws, never returns a wrong-length key. */
export function getSeedEncryptionKey(): Buffer {
  const raw = process.env.SEED_ENCRYPTION_KEY;
  if (!raw) {
    throw new InvalidEncryptionKeyError("SEED_ENCRYPTION_KEY is not set");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new InvalidEncryptionKeyError(
      `expected 32 bytes after base64 decode, got ${key.length}. Generate one with: openssl rand -base64 32`,
    );
  }
  return key;
}

export function getChainConfig(chain: Chain): ChainConfig {
  const network = getCryptoNetworkMode();
  const testnet = network === "testnet";

  if (chain === "BEP20") {
    const rpcUrls = testnet
      ? [process.env.CRYPTO_BSC_TESTNET_RPC ?? "https://data-seed-prebsc-1-s1.bnbchain.org:8545"]
      : resolveMainnetRpcUrls("CRYPTO_BSC_MAINNET_RPCS", "CRYPTO_BSC_MAINNET_RPC", DEFAULT_BSC_MAINNET_RPCS);
    return {
      chain,
      network,
      rpcUrls,
      rpcUrl: firstRpcUrl(rpcUrls, chain),
      usdtContract: testnet
        ? envRequired("CRYPTO_BSC_TESTNET_USDT_CONTRACT")
        : (process.env.CRYPTO_BSC_MAINNET_USDT_CONTRACT ?? "0x55d398326f99059fF775485246999027B3197955"),
      tokenDecimals: envInt(testnet ? "CRYPTO_BSC_TOKEN_DECIMALS_TESTNET" : "CRYPTO_BSC_TOKEN_DECIMALS_MAINNET", 18),
      confirmationsRequired: testnet ? 3 : mainnetConfirmations(chain, "CRYPTO_BSC_CONFIRMATIONS"),
      scanIntervalMs: 15_000,
      // Lowered from the original 2,000 default — see the "production
      // incident" note in retry.ts's header. A tick that couldn't complete
      // a 2,000-block eth_getLogs call against any free-tier endpoint
      // never advanced its cursor at all; a smaller per-tick range (now
      // additionally split into eventChunkSize-sized calls below) means a
      // backlog is worked off gradually instead of retried at the same
      // too-large size forever.
      // ================================================================
      // 20,000, RAISED FROM 300 ON 2026-08-19 — and the old number was
      // not wrong, it was sized for a query that no longer happens.
      // ================================================================
      // 300 existed because an UNFILTERED eth_getLogs could not be made
      // to work at any width, so a tick was capped to limit the damage of
      // retrying a too-large call forever. With the recipient filter
      // (chains/bsc.ts) a single call now spans thousands of blocks and
      // returns almost nothing.
      //
      // *** THIS IS THE NUMBER THAT DECIDES WHETHER A BACKLOG DRAINS.
      // eventChunkSize decides how big one CALL is; this decides how far
      // one TICK advances. *** At 300 a 142,000-block backlog needs 473
      // ticks — nearly eight hours at one tick a minute. At 20,000 it is
      // eight.
      //
      // WHY 20,000 IS SAFE DESPITE BEING A BIG TICK: the scheduler
      // (lib/crypto/scheduler.ts) reschedules with setTimeout AFTER a
      // tick completes, so ticks CANNOT overlap — a slow tick delays the
      // next one instead of stacking on it. And each completed chunk is
      // banked (see chains/bsc.ts), so a tick that dies halfway still
      // advances the cursor by what it finished.
      //
      // *** 4,000 AND NOT 20,000 — AND THE FIRST NUMBER I PICKED WAS
      // 20,000, WHICH A VERIFY ASSERTION REJECTED. ***
      //
      // Measured latency on the filtered call is 5-27s, and it is
      // roughly INDEPENDENT OF SPAN — the cost is per call, not per
      // block. At 20,000 blocks that is 10 calls, and at the slow end of
      // the measurement a single tick runs ~272 SECONDS against a
      // 60-second interval.
      //
      // That is not a correctness problem: lib/crypto/scheduler.ts
      // reschedules with setTimeout AFTER a tick completes, so ticks
      // cannot overlap and a long one merely delays the next.
      //
      // *** IT IS A DETECTION-LATENCY PROBLEM, AND ONLY WHILE A BACKLOG
      // EXISTS. *** The live window (monitor/scanner.ts) runs once per
      // TICK, not per chunk, so a 272-second tick means a NEW deposit
      // can wait four and a half minutes to be seen — during exactly
      // the period when the system is already behind. Chunk-level
      // partial progress keeps the cursor moving inside a long tick, so
      // the drain does not suffer; the live window does.
      //
      // 4,000 = 2 calls ≈ 54s at the slow end, inside the interval.
      // Draining 149,000 blocks takes ~38 ticks either way, because the
      // total work is identical — the only thing that changes is how
      // often the present gets looked at while that happens.
      //
      // In steady state this constant does not matter at all: once
      // caught up, `toBlock` IS `latest` and the range is whatever the
      // chain produced in a minute.
      maxBlockRange: envInt("CRYPTO_BSC_MAX_BLOCK_RANGE", 4_000),
      // ================================================================
      // 50, RAISED FROM 10 ON 2026-08-18. The old comment here read "10
      // is the binding constraint" because blastapi caps eth_getLogs at
      // a 10-block range — but that reasoning had stopped being true:
      // blastapi is not the endpoint serving these calls at all, and
      // neither is meowrpc, which answers every eth_getLogs with "the
      // method is not supported". Both are now rotated away from by the
      // pool (chains/rpc-pool.ts). The ONE endpoint that actually serves
      // this call is blxrbdn, and it was MEASURED handling a 200-block
      // request returning 17,516 logs. 50 keeps a 4x margin on that
      // measurement while cutting call volume 5x.
      //
      // *** THE DEFAULT MOVED BECAUSE A VALUE THAT LIVES ONLY IN .env
      // DOES NOT TRAVEL. *** The raise was applied as an env override on
      // this one server. Any fresh environment, rebuilt machine or
      // dropped line silently reverted to 10 — the number tuned for a
      // constraint that no longer applies — with nothing to say so. An
      // env var should express a deployment's deviation from a sane
      // default, not carry the sane default by itself.
      //
      // An endpoint that cannot serve it is not a hazard: it returns a
      // "block range" error, which isRateLimitClassError already
      // classifies, so the pool cools it and rotates instead of failing
      // the tick.
      //
      // ================================================================
      // *** 2,000, RAISED FROM 50 ON 2026-08-19 — AND DELIBERATELY NOT
      // 5,000, WHICH IS WHAT THE ENDPOINT ACTUALLY ALLOWS. ***
      // ================================================================
      // Both numbers above were sized for an UNFILTERED query that asked
      // for every USDT transfer on BSC. With the recipient filter the
      // constraint changed shape entirely, so the old measurement (200
      // blocks, 17,516 logs) no longer describes anything we do.
      //
      // MEASURED 2026-08-19 against bsc.rpc.blxrbdn.com with a 20-address
      // filter:
      //     span 1,000  -> OK          span 2,000 -> OK
      //     span 5,000  -> OK          span 10,000 -> "exceed maximum
      //                                                block range: 5000"
      //     latency 5-19s, ROUGHLY INDEPENDENT OF SPAN
      //
      // Latency being per-CALL rather than per-BLOCK means wider is
      // strictly cheaper per block scanned, so the only question is how
      // wide is safe.
      //
      // *** IT IS 2,000 AND NOT 5,000 BECAUSE 5,000 IS ONE ENDPOINT'S
      // CEILING, AND THE POOL ROTATES. *** The chunk has to work on the
      // WEAKEST endpoint the pool may pick, not the best one it happened
      // to be measured against — and mainstream providers commonly cap
      // getLogs at 1,000-2,000 blocks. Designing at a ceiling is how you
      // discover that the ceiling varies: the failure would appear only
      // after a rotation, look like an outage, and be attributed to the
      // new endpoint rather than to this constant.
      //
      // 2,000 is 40x fewer calls than 50 while sitting inside every cap
      // this pool is likely to meet. Raise it ONLY with a measurement
      // against the endpoint that is actually serving traffic, and
      // remember that the pool may not be serving from it tomorrow.
      // ================================================================
      eventChunkSize: envInt("CRYPTO_BSC_EVENT_CHUNK_SIZE", 2_000),
      explorerTxUrl: (txHash) =>
        testnet ? `https://testnet.bscscan.com/tx/${txHash}` : `https://bscscan.com/tx/${txHash}`,
    };
  }

  const rpcUrls = testnet
    ? [process.env.CRYPTO_TRON_TESTNET_RPC ?? "https://api.shasta.trongrid.io"]
    : resolveMainnetRpcUrls("CRYPTO_TRON_MAINNET_RPCS", "CRYPTO_TRON_MAINNET_RPC", DEFAULT_TRON_MAINNET_RPCS);
  return {
    chain,
    network,
    rpcUrls,
    rpcUrl: firstRpcUrl(rpcUrls, chain),
    usdtContract: testnet
      ? envRequired("CRYPTO_TRON_TESTNET_USDT_CONTRACT")
      : (process.env.CRYPTO_TRON_MAINNET_USDT_CONTRACT ?? "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"),
    tokenDecimals: envInt(testnet ? "CRYPTO_TRON_TOKEN_DECIMALS_TESTNET" : "CRYPTO_TRON_TOKEN_DECIMALS_MAINNET", 6),
    confirmationsRequired: testnet ? 3 : mainnetConfirmations(chain, "CRYPTO_TRON_CONFIRMATIONS"),
    scanIntervalMs: 20_000,
    maxBlockRange: envInt("CRYPTO_TRON_MAX_BLOCK_RANGE", 2_000),
    // Unused on TRC20 — Tron event scanning is paginated by TronGrid's own
    // timestamp-range + `meta.links.next` cursor (lib/crypto/chains/tron.ts),
    // not a per-request block-count cap like BSC's eth_getLogs. Present
    // only so both branches satisfy the same ChainConfig shape.
    eventChunkSize: 0,
    explorerTxUrl: (txHash) =>
      testnet ? `https://shasta.tronscan.org/#/transaction/${txHash}` : `https://tronscan.org/#/transaction/${txHash}`,
  };
}

export const CONFIRMATION_CHECK_INTERVAL_MS = 15_000;

/**
 * TronGrid's `/v1/contracts/{address}/events` REST endpoint is a
 * TronGrid-specific indexer API — it does NOT exist on every Tron RPC
 * endpoint, including publicnode's `tron-rpc.publicnode.com` (a
 * JSON-RPC/full-node-API gateway, not a TronGrid mirror). Before this fix,
 * lib/crypto/chains/tron.ts#getIncomingTransfers reused the SAME
 * round-robin pool as every other Tron RPC call
 * (config.rpcUrls, which defaults to `[api.trongrid.io,
 * tron-rpc.publicnode.com]` on mainnet) for this REST call too — whenever
 * the pool's cursor landed on publicnode, every events request 404'd, and
 * because `isRateLimitClassError` doesn't treat 404 as rotate-worthy, the
 * whole scan tick failed outright instead of falling back to trongrid.
 * This is the actual, observed "TronGrid 404" production bug — not a
 * stale/wrong URL *path* (the path itself, `/v1/contracts/.../events`, is
 * correct). The fix is a separate, TronGrid-only URL list used ONLY for
 * this specific REST call; getLatestBlock/getConfirmations/balance reads
 * keep using the full general-purpose rpcUrls pool, which still benefits
 * from publicnode as a fallback for those.
 */
// ======================================================================
// *** THIS IS THE ONLY VAR THAT FEEDS TRC20 DEPOSIT DETECTION. ***
// ======================================================================
// NOT `CRYPTO_TRON_MAINNET_RPCS`. That one feeds the general-purpose
// pool (block timestamps, confirmations, balances) and may list several
// endpoints; a reader of .env reasonably concludes deposit detection has
// a fallback. IT DOES NOT. Deposit detection uses the TronGrid-specific
// events REST route, which `tron-rpc.publicnode.com` and every generic
// JSON-RPC gateway do not implement, so only TronGrid-compatible hosts
// belong here.
//
// CONSEQUENCE, stated because it went unstated for months and cost us a
// stalled scanner: with this unset, TRC20 detection runs on EXACTLY ONE
// endpoint, with no fallback and — unlike BEP20 — no partial-progress
// recovery either (see getIncomingTransfers in chains/tron.ts). If
// TronGrid rate-limits us, TRC20 detection stops entirely until it
// relents.
//
// THE REAL REMEDY IS A TRONGRID API KEY, not a second free host: the
// free tier is the constraint, and no drop-in compatible alternative
// exists for this route. Until then this is a known single point of
// failure, deliberately visible rather than buried.
export function getTronEventsRpcUrls(): string[] {
  const testnet = getCryptoNetworkMode() === "testnet";
  if (testnet) {
    return [process.env.CRYPTO_TRON_TESTNET_RPC ?? "https://api.shasta.trongrid.io"];
  }
  const multi = process.env.CRYPTO_TRON_EVENTS_RPCS;
  if (multi) {
    const urls = multi.split(",").map((s) => s.trim()).filter(Boolean);
    if (urls.length > 0) return urls;
  }
  return ["https://api.trongrid.io"];
}

/** Idle time after which the in-memory decrypted seed is wiped; re-loaded from DB on next use. */
export const SEED_MEMORY_TTL_MS = 60 * 60 * 1000;
