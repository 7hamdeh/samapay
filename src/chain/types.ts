// THE CHAIN LAYER, AS INTERFACES. Signatures are cut to the REAL shapes in
// SamaPrime's lib/crypto (hd/derive.ts, monitor/scanner.ts,
// chains/safe-broadcast.ts, chains/tx-existence.ts, seed/vault.ts) so that
// step 4 — the code MOVE, Ibrahim's maintenance window — relocates
// implementations behind these names rather than rewriting them. NO CODE IS
// COPIED ACROSS BEFORE THAT STEP: one private key, one code home.
import type { Chain } from "@prisma/client";

/**
 * How deep a block must be before its transfers may be treated as real.
 *
 * ⚠️ THIS LIVES HERE, NOT IN THE OBSERVER, BECAUSE TWO MODULES NEED IT AND A
 * SECOND COPY IS HOW A CHECK STOPS CHECKING (Ibrahim, 2026-09-07):
 *   - the OBSERVER waits for this depth before crediting a deposit
 *   - the SCANNER must not look SHALLOWER than it, or it asks TronGrid for
 *     "confirmed transfers" in a block that is not yet confirmed, gets an
 *     empty answer that is indistinguishable from "no transfers", and
 *     advances its cursor past a real deposit forever.
 *
 * That is not hypothetical: it is exactly how a 3.010000 USDT TRC20 deposit
 * in block 86022515 was missed on 2026-09-07. The reader was correct; it
 * asked at the wrong depth.
 */
export const CONFIRMATIONS_REQUIRED: Record<Chain, number> = { BEP20: 15, TRC20: 19 }; // SamaPrime's mainnet defaults

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

export interface ChainObserver {
  /** Transfers to any of `addresses` between the cursor and head; the observer persists its own cursor. */
  scan(chain: Chain, addresses: ReadonlySet<string>): Promise<ObservedTransfer[]>;
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
