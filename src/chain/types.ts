// THE CHAIN LAYER, AS INTERFACES. Signatures are cut to the REAL shapes in
// SamaPrime's lib/crypto (hd/derive.ts, monitor/scanner.ts,
// chains/safe-broadcast.ts, chains/tx-existence.ts, seed/vault.ts) so that
// step 4 — the code MOVE, Ibrahim's maintenance window — relocates
// implementations behind these names rather than rewriting them. NO CODE IS
// COPIED ACROSS BEFORE THAT STEP: one private key, one code home.
import type { Chain } from "@prisma/client";

// ⚠️ THERE IS DELIBERATELY NO `CONFIRMATIONS_REQUIRED` CONSTANT HERE ANY MORE.
// One used to live in this file, and `chain/impl/config.ts` carried a second,
// identical-valued one (`MAINNET_CONFIRMATION_FLOOR`) for the env-overridable
// path — two definitions of one money-path quantity, and nothing compared
// them (docs/confirmation-depth-divergence-2026-09-07.md). Both the OBSERVER
// (crediting decision) and the SCANNER (how shallow it may look — see
// `chain/live.ts`, and the 2026-09-07 missed-deposit note there) now read the
// SAME number from the SAME place: `getChainConfig(chain).confirmationsRequired`
// in `chain/impl/config.ts`, which is the one that honours
// `CRYPTO_{BSC,TRON}_CONFIRMATIONS`. `observeChain`/`promoteConfirmed` below
// take it as an explicit parameter rather than reaching for a module-level
// constant, so there is no second copy left to drift.

export interface DerivedAddress {
  chain: Chain;
  address: string;
  derivationIndex: number;
}

export interface AddressDeriver {
  /** Next unused index for the chain, derived from the vault's seed. Throws when the vault is locked. */
  deriveNext(chain: Chain): Promise<DerivedAddress>;
}

export interface ObservedTransfer {
  chain: Chain;
  txHash: string;
  toAddress: string;
  amount: string; // decimal string in token units, already precision-corrected per chain
  blockNumber: bigint;
  confirmations: number;
}

/**
 * One scan's result, NOTHING PERSISTED. `scannedThrough` is the highest block
 * actually scanned (null = none). The OBSERVER advances the cursor to it, under
 * the chain's cursor lock, ONLY after every transfer is recorded — a cursor
 * written before the records is a deposit lost on the first failed insert
 * (Q's review B1, 2026-09-24).
 */
export interface ScanBatch { transfers: ObservedTransfer[]; scannedThrough: bigint | null }

export interface ChainObserver {
  /**
   * Transfers to any of `addresses` from the cursor on. A ScanBatch (the live
   * scanner) hands the cursor to the observer; a bare array (test doubles with
   * no cursor) moves none.
   */
  scan(chain: Chain, addresses: ReadonlySet<string>): Promise<ObservedTransfer[] | ScanBatch>;
  confirmationsFor(chain: Chain, txHash: string): Promise<number>;
}

// `preBroadcast` reasons are refusals that happen BEFORE anything reached the
// network by construction (no signed tx exists) — the only case a `failed`
// row may be refunded with an empty txHashesChecked. `unknown` means the
// adapter got as far as signing (or cannot say): `candidateTxHash` is the
// hash of the signed tx, stored on the row so the reconciler can prove its
// absence on-chain before anything is restored.
export type PreBroadcastReason = "insufficient_gas" | "nonce_refused" | "invalid_address" | "rejected_pre_broadcast";
export type BroadcastResult =
  | { ok: true; txHash: string }
  | { ok: false; reason: PreBroadcastReason; detail: string }
  | { ok: false; reason: "unknown"; detail: string; candidateTxHash: string | null };

export interface TxSender {
  /** Pinned-nonce, single-attempt broadcast. Never retries on its own; a retry is a NEW decision by the caller. */
  send(chain: Chain, toAddress: string, amount: string): Promise<BroadcastResult>;
}

export type TxExistence =
  | { known: true; confirmed: boolean; confirmations: number; node: string }
  | { known: false; checkedAt: Date; nodes: string[] }; // DISTINCT hostnames that actually answered — a count cannot show one host asked twice

export interface TxExistenceProver {
  /** The on-chain-absence proof markRefunded requires. `known:false` is evidence only when >= 2 DISTINCT nodes answered; the reconciler enforces and records WHICH. */
  exists(chain: Chain, txHash: string): Promise<TxExistence>;
}

export interface SeedVault {
  isUnlocked(): boolean;
  fingerprint(): string | null; // 8 chars, the only thing about the seed that may ever surface
}
