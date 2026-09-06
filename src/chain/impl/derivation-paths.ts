// BIP44 account-level separation between user deposit addresses and
// system-controlled signing addresses (Phase 3-MVP-1). Added after a real
// collision: account 0' index 0 was used as BOTH "the hot wallet" (signing
// source for withdrawal-sender/auto-sweeper) AND a specific real user's
// original deposit address (userId cmsbsbn7i0001xtomcx110sr8) — see
// docs/SECURITY.md "Hot Wallet Isolation" and docs/INVARIANTS.md "Crypto".
//
// User addresses stay on account 0' (unchanged — every existing
// CryptoAddress row still derives correctly). The hot wallet moves to its
// own account (1'), which can never collide with a user index because
// getOrCreateAddress() only ever allocates within account 0'
// (lib/crypto/addresses.ts). Accounts 2'/3' are reserved for a future
// warm/cold wallet split — not used by any code yet.
import type { Chain } from "@prisma/client";

// coin_type per the BIP44 registry: 60 = Ethereum (BSC is EVM-compatible
// and reuses it), 195 = Tron. Mirrors lib/crypto/hd/derive.ts's existing
// coin-type mapping — kept in sync deliberately, not re-derived elsewhere.
function coinType(chain: Chain): number {
  return chain === "BEP20" ? 60 : 195;
}

export const USER_ACCOUNT_ROOT = "0'" as const;
export const HOT_WALLET_ACCOUNT = "1'" as const;
export const WARM_WALLET_ACCOUNT = "2'" as const; // reserved, nothing derives from this yet
export const COLD_WALLET_ACCOUNT = "3'" as const; // reserved, nothing derives from this yet

export const DERIVATION_PATHS = {
  /** m/44'/{coinType}'/0'/0/{userIndex} — existing per-user deposit addresses, unchanged. */
  USER_ACCOUNT: (chain: Chain, userIndex: number) => `m/44'/${coinType(chain)}'/${USER_ACCOUNT_ROOT}/0/${userIndex}`,
  /** m/44'/{coinType}'/1'/0/0 — the ONLY path ever used as a hot wallet signing source. Never a user index. */
  HOT_WALLET: (chain: Chain) => `m/44'/${coinType(chain)}'/${HOT_WALLET_ACCOUNT}/0/0`,
  /** m/44'/{coinType}'/2'/0/0 — reserved for a future warm wallet, not wired to any code path yet. */
  WARM_WALLET: (chain: Chain) => `m/44'/${coinType(chain)}'/${WARM_WALLET_ACCOUNT}/0/0`,
  /** m/44'/{coinType}'/3'/0/0 — reserved for a future cold wallet, not wired to any code path yet. */
  COLD_WALLET: (chain: Chain) => `m/44'/${coinType(chain)}'/${COLD_WALLET_ACCOUNT}/0/0`,
} as const;
