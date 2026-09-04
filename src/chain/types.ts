// THE CHAIN LAYER, AS INTERFACES. Signatures are cut to the REAL shapes in
// SamaPrime's lib/crypto (hd/derive.ts, monitor/scanner.ts,
// chains/safe-broadcast.ts, chains/tx-existence.ts, seed/vault.ts) so that
// step 4 — the code MOVE, Ibrahim's maintenance window — relocates
// implementations behind these names rather than rewriting them. NO CODE IS
// COPIED ACROSS BEFORE THAT STEP: one private key, one code home.
import type { Chain } from "@prisma/client";

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

export type BroadcastResult =
  | { ok: true; txHash: string }
  | { ok: false; reason: "insufficient_gas" | "rejected" | "unknown"; detail: string };

export interface TxSender {
  /** Pinned-nonce, single-attempt broadcast. Never retries on its own; a retry is a NEW decision by the caller. */
  send(chain: Chain, toAddress: string, amount: string): Promise<BroadcastResult>;
}

export type TxExistence =
  | { known: true; confirmed: boolean; confirmations: number }
  | { known: false; checkedAt: Date; nodesAsked: number };

export interface TxExistenceProver {
  /** The on-chain-absence proof markRefunded requires. `known:false` is evidence only with nodesAsked >= 2. */
  exists(chain: Chain, txHash: string): Promise<TxExistence>;
}

export interface SeedVault {
  isUnlocked(): boolean;
  fingerprint(): string | null; // 8 chars, the only thing about the seed that may ever surface
}
