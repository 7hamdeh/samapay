// Hot wallet address resolution (Phase 3-MVP-1). The hot wallet lives at a
// dedicated BIP44 account — m/44'/60'/1'/0/0 (BEP20), m/44'/195'/1'/0/0
// (TRC20) — via lib/crypto/derivation-paths.ts, never a user account index.
// See docs/SECURITY.md "Hot Wallet Isolation" for why: the previous
// convention ("index 0 = hot wallet") collided with a real user's own
// deposit address.
//
// The address is always DETERMINISTIC and re-derived fresh from the vault
// seed whenever a caller needs it for signing (withdraw-sender.ts,
// auto-sweeper.ts derive it directly from lib/crypto/hd/derive.ts once they
// already hold the unlocked seed — they don't go through this module).
// This module is the public entry point for callers that do NOT already
// hold the seed: read-only address lookup (requires the vault unlocked)
// and a small DB-backed cache of the last-derived addresses so admin UI /
// other read-only code can display them even while the vault is locked.
// The cached CryptoConfig columns are informational only — NEVER a signing
// source, never trusted over a fresh derivation when the seed is available.
import type { Chain } from "@prisma/client";
import { prisma } from "@/db/client.js";
import { logger } from "@/log.js";
import { getVaultSeed, isUnlocked as isVaultUnlocked } from "@/chain/seed/vault.js";
import { deriveHotWalletAddress as deriveHotWalletAddressFromSeed } from "@/chain/hd/derive.js";

export class HotWalletVaultLockedError extends Error {
  constructor() {
    super("Hot wallet address derivation requires the seed vault to be unlocked.");
    this.name = "HotWalletVaultLockedError";
  }
}

/**
 * Derives the hot wallet address fresh from the currently-unlocked vault
 * seed. Throws HotWalletVaultLockedError if the vault is locked — same
 * gating discipline as every other vault-dependent operation
 * (docs/INVARIANTS.md). Deterministic: never cached in a variable here:
 * the CryptoConfig cache (see getCachedHotWalletAddresses) exists purely
 * for locked-state display, not as this function's source of truth.
 */
export async function getHotWalletAddress(chain: Chain): Promise<string> {
  if (!isVaultUnlocked()) {
    throw new HotWalletVaultLockedError();
  }
  return deriveHotWalletAddressFromSeed(getVaultSeed(), chain);
}

/**
 * Derives both hot wallet addresses from an already-unlocked seed and
 * upserts them into CryptoConfig for read-only display when the vault is
 * later locked again. Takes the seed directly (not via getVaultSeed())
 * so this can be called from lib/crypto/seed/vault.ts#unlockVault right
 * after a successful unlock without that module importing this one back
 * (would create a circular import — vault.ts -> hot-wallet.ts -> vault.ts).
 * Logged at info level so the address is visible in server logs for
 * funding purposes (docs/SECURITY.md).
 */
export async function cacheHotWalletAddresses(seed: Buffer): Promise<{ bep20: string; trc20: string }> {
  const bep20 = deriveHotWalletAddressFromSeed(seed, "BEP20");
  const trc20 = deriveHotWalletAddressFromSeed(seed, "TRC20");

  await prisma.cryptoConfig.update({
    where: { id: 1 },
    data: { hotWalletAddressBep20: bep20, hotWalletAddressTrc20: trc20 },
  });

  logger.info({ action: "hotWalletAddressesDerived", bep20, trc20 }, "Hot wallet addresses derived and cached for display");
  return { bep20, trc20 };
}

export interface CachedHotWalletAddresses {
  bep20: string | null;
  trc20: string | null;
}

/** Read-only cached addresses for admin display when the vault is locked. Never a signing source. */
export async function getCachedHotWalletAddresses(): Promise<CachedHotWalletAddresses> {
  const config = await prisma.cryptoConfig.findUnique({
    where: { id: 1 },
    select: { hotWalletAddressBep20: true, hotWalletAddressTrc20: true },
  });
  return { bep20: config?.hotWalletAddressBep20 ?? null, trc20: config?.hotWalletAddressTrc20 ?? null };
}
