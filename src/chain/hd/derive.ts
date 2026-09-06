// BIP39/32/44 HD derivation. Deterministic: same seed + chain + path always
// produces the same address (property-tested in tests/crypto/hd.test.ts).
import { HDKey } from "@scure/bip32";
import { ethers } from "ethers";
import { TronWeb } from "tronweb";
import type { Chain } from "@prisma/client";
import { AddressDerivationFailedError } from "@/chain/impl/errors.js";
import { DERIVATION_PATHS } from "@/chain/impl/derivation-paths.js";

// BIP44: m / purpose' / coin_type' / account' / change / address_index
// Path strings themselves come from lib/crypto/derivation-paths.ts (single
// source of truth for the account-level split between user addresses and
// the hot wallet) — this module only ever turns a path into key material.
function derivePrivateKeyFromPath(seed: Buffer, chain: Chain, path: string): Uint8Array {
  const root = HDKey.fromMasterSeed(seed);
  const child = root.derive(path);
  if (!child.privateKey) {
    throw new AddressDerivationFailedError(chain, path, "derived node has no private key");
  }
  return child.privateKey;
}

function derivePrivateKey(seed: Buffer, chain: Chain, index: number): Uint8Array {
  if (!Number.isInteger(index) || index < 0) {
    throw new AddressDerivationFailedError(chain, index, "derivationIndex must be a non-negative integer");
  }
  return derivePrivateKeyFromPath(seed, chain, DERIVATION_PATHS.USER_ACCOUNT(chain, index));
}

function addressFromPrivateKey(chain: Chain, privateKey: Uint8Array): string {
  if (chain === "BEP20") {
    const wallet = new ethers.Wallet(ethers.hexlify(privateKey));
    return wallet.address;
  }
  const address = TronWeb.address.fromPrivateKey(Buffer.from(privateKey).toString("hex"));
  if (!address) {
    throw new AddressDerivationFailedError("TRC20", -1, "TronWeb.address.fromPrivateKey returned false");
  }
  return address;
}

/**
 * Raw private key bytes for a seed+chain+index — needed by
 * lib/crypto/sweep/auto-sweeper.ts to sign the outbound USDT transfer from
 * a swept user address (never the hot wallet — see
 * deriveHotWalletPrivateKey for that). Exported deliberately: this
 * module's existing address-only exports (deriveBep20Address etc.) are the
 * right boundary for read-only address derivation, but signing genuinely
 * needs the private key itself. Callers must never log, persist, or
 * return this — same handling discipline as the master seed itself
 * (docs/SECURITY.md).
 */
export function derivePrivateKeyForSigning(seed: Buffer, chain: Chain, index: number): Uint8Array {
  return derivePrivateKey(seed, chain, index);
}

/** Derives the BEP20 (BSC) address for a given seed + index. Deterministic. */
export function deriveBep20Address(seed: Buffer, index: number): string {
  return addressFromPrivateKey("BEP20", derivePrivateKey(seed, "BEP20", index));
}

/** Derives the TRC20 (Tron) address for a given seed + index. Deterministic. */
export function deriveTrc20Address(seed: Buffer, index: number): string {
  return addressFromPrivateKey("TRC20", derivePrivateKey(seed, "TRC20", index));
}

export function deriveAddress(seed: Buffer, chain: Chain, index: number): string {
  return chain === "BEP20" ? deriveBep20Address(seed, index) : deriveTrc20Address(seed, index);
}

/**
 * Hot wallet private key — ALWAYS m/44'/60'/1'/0/0 (BEP20) or
 * m/44'/195'/1'/0/0 (TRC20), never a user account index. This is the ONLY
 * function withdrawal-sender/auto-sweeper may use to obtain the hot
 * wallet's signing key — see docs/SECURITY.md "Hot Wallet Isolation" for
 * why the old "index 0" convention was unsafe (it collided with a real
 * user's deposit address).
 */
export function deriveHotWalletPrivateKey(seed: Buffer, chain: Chain): Uint8Array {
  return derivePrivateKeyFromPath(seed, chain, DERIVATION_PATHS.HOT_WALLET(chain));
}

/** Hot wallet address — deterministic from the seed, never cached, never a user address. */
export function deriveHotWalletAddress(seed: Buffer, chain: Chain): string {
  return addressFromPrivateKey(chain, deriveHotWalletPrivateKey(seed, chain));
}
