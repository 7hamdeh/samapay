export type CryptoErrorCode =
  | "seed_not_configured"
  | "seed_decrypt_failed"
  | "seed_fingerprint_mismatch"
  | "seed_already_configured"
  | "invalid_encryption_key"
  | "chain_rpc_error"
  | "address_derivation_failed"
  | "deposit_already_credited"
  | "deposit_not_confirmed"
  | "config_invalid";

export class CryptoError extends Error {
  readonly code: CryptoErrorCode;

  constructor(code: CryptoErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CryptoError";
    this.code = code;
  }
}

export class SeedNotConfiguredError extends CryptoError {
  constructor() {
    super(
      "seed_not_configured",
      "No CryptoConfig row exists yet. Run `pnpm exec tsx lib/crypto/seed/cli-generate.ts` once to generate the master seed.",
    );
  }
}

export class SeedDecryptFailedError extends CryptoError {
  constructor(cause: unknown) {
    super("seed_decrypt_failed", "Failed to decrypt the stored master seed with SEED_ENCRYPTION_KEY.", { cause });
  }
}

export class SeedFingerprintMismatchError extends CryptoError {
  constructor() {
    super(
      "seed_fingerprint_mismatch",
      "Decrypted seed's fingerprint does not match the stored fingerprint — SEED_ENCRYPTION_KEY may not match the key used to encrypt this blob.",
    );
  }
}

export class SeedAlreadyConfiguredError extends CryptoError {
  constructor() {
    super(
      "seed_already_configured",
      "A CryptoConfig row already exists — refusing to overwrite an existing master seed. Rotating the seed is a manual, deliberate DB operation, not something this CLI does implicitly.",
    );
  }
}

export class InvalidEncryptionKeyError extends CryptoError {
  constructor(detail: string) {
    super("invalid_encryption_key", `SEED_ENCRYPTION_KEY is invalid: ${detail}`);
  }
}

export class ChainRpcError extends CryptoError {
  constructor(chain: string, cause: unknown) {
    super("chain_rpc_error", `RPC call failed for chain ${chain}.`, { cause });
  }
}

export class AddressDerivationFailedError extends CryptoError {
  // `index` also accepts a full derivation path string — the hot wallet
  // (lib/crypto/hd/derive.ts#deriveHotWalletAddress) has no single index of
  // its own, just a fixed BIP44 path (docs/SECURITY.md "Hot Wallet Isolation").
  constructor(chain: string, index: number | string, detail: string) {
    super("address_derivation_failed", `Failed to derive ${chain} address at ${index}: ${detail}`);
  }
}

export class ConfigInvalidError extends CryptoError {
  constructor(detail: string) {
    super("config_invalid", `Invalid crypto module configuration: ${detail}`);
  }
}
