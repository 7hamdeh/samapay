// Argon2id passphrase key derivation for the seed vault (Phase 2A-FAST).
// See lib/crypto/seed/vault.ts for how this is combined with
// SEED_ENCRYPTION_KEY, and docs/SECURITY.md "Vault + Passphrase" for the
// threat model. Params match the task spec exactly — memory-hard enough
// to resist offline brute force of a stolen vault_verifier blob, without
// being so slow it makes /admin/unlock unusable (empirically ~150-300ms
// on typical server hardware for these params).
import crypto from "node:crypto";
import { hashRaw } from "@node-rs/argon2";
import { ConfigInvalidError } from "@/chain/impl/errors.js";

const MEMORY_COST_KIB = 65_536; // 64 MiB
const TIME_COST = 3;
const PARALLELISM = 4;
const OUTPUT_LEN = 32;
// @node-rs/argon2's Algorithm is declared `const enum`, which this
// project's `isolatedModules` TS setting can't import (TS2748) — using
// the raw value (2 = Argon2id, per that package's own index.d.ts) avoids
// the import entirely rather than weakening tsconfig for one dependency.
const ARGON2ID = 2;

/** Base64-decodes and validates PASSPHRASE_SALT (32 raw bytes, like SEED_ENCRYPTION_KEY). */
export function getPassphraseSalt(): Buffer {
  const raw = process.env.PASSPHRASE_SALT;
  if (!raw) {
    throw new ConfigInvalidError(
      "PASSPHRASE_SALT is not set — required for the seed vault. Generate once with: openssl rand -base64 32. Never change it after the vault is set up (scripts/migrate-seed-to-vault.ts): changing the salt makes every previously-derived vault key unreproducible, permanently locking the vault out.",
    );
  }
  const salt = Buffer.from(raw, "base64");
  if (salt.length !== 32) {
    throw new ConfigInvalidError(`PASSPHRASE_SALT must decode to 32 bytes, got ${salt.length}.`);
  }
  return salt;
}

/**
 * Derives a 32-byte key from the admin's passphrase via Argon2id, using
 * the deterministic PASSPHRASE_SALT (same salt every time, by design —
 * this isn't password storage where per-user random salts matter; it's a
 * single shared operator secret, and a fixed salt is what makes the
 * derivation reproducible across server restarts without persisting
 * anything passphrase-derived).
 */
export async function deriveArgon2Key(passphrase: string): Promise<Buffer> {
  const salt = getPassphraseSalt();
  const raw = await hashRaw(Buffer.from(passphrase, "utf8"), {
    algorithm: ARGON2ID,
    memoryCost: MEMORY_COST_KIB,
    timeCost: TIME_COST,
    parallelism: PARALLELISM,
    salt,
    outputLen: OUTPUT_LEN,
  });
  return Buffer.from(raw);
}

/**
 * Combines the two independent secrets (env-held SEED_ENCRYPTION_KEY +
 * admin-entered passphrase) into one 32-byte vault key via XOR, then
 * stretches it through HKDF — matching the envelope format in the task
 * spec (`HKDF(SEED_ENCRYPTION_KEY XOR argon2(passphrase, salt))`).
 * Neither secret alone reproduces this key: a leaked SEED_ENCRYPTION_KEY
 * (env compromise) is insufficient without the passphrase (never stored
 * anywhere, only ever held in the admin's memory + this request's body),
 * and a leaked/guessed passphrase is insufficient without the env key.
 */
export function combineAndStretchKey(seedEncryptionKey: Buffer, argon2Key: Buffer): Buffer {
  if (seedEncryptionKey.length !== 32 || argon2Key.length !== 32) {
    throw new ConfigInvalidError("combineAndStretchKey requires two 32-byte inputs");
  }
  const xored = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) {
    const a = seedEncryptionKey[i];
    const b = argon2Key[i];
    // Unreachable: both are asserted 32 bytes immediately above. Written as a
    // THROW and never as a cast, because in JavaScript `undefined ^ undefined`
    // is 0 — so a future edit that weakened the length guard would not error,
    // it would silently derive a DIFFERENT KEY from zeroed bytes, and every
    // blob written under it would be unrecoverable with no failure anywhere.
    if (a === undefined || b === undefined) throw new ConfigInvalidError("combineAndStretchKey: input shorter than 32 bytes at index " + i);
    xored[i] = a ^ b;
  }
  // HKDF-SHA256, no separate salt (the entropy already comes from both
  // combined secrets above) — info string binds this derivation to its
  // specific purpose so it can never collide with a key derived for a
  // different purpose from the same input material.
  const okm = crypto.hkdfSync("sha256", xored, Buffer.alloc(0), "salamwallet-vault-key-v1", 32);
  return Buffer.from(okm);
}
