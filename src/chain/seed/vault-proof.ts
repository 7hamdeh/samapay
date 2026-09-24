// Vault PROOF (contract §8.2): scripts/prove-vault.ts writes the vault
// verifier for the seed now in crypto_config, and /health reports it.
//
// What "proven" means, exactly: crypto_config holds one seed that decrypts
// with SEED_ENCRYPTION_KEY to its own fingerprint (derivation: ready), AND a
// vault verifier is stored. A verifier can only be stored by
// writeVaultVerifier, which first opens it again with a FRESH Argon2id
// derivation through vault.ts#verifyVaultPassphrase — the same function
// unlockVault runs — so a stored verifier is one an unlock has already
// succeeded against. The import clears the verifier (it belongs to the old
// seed), so "proven" can never describe a verifier written for another seed.
// /health cannot re-check the passphrase itself: it is never stored anywhere.
import { z } from "zod";
import { prisma } from "@/db/client.js";
import { logger } from "@/log.js";
import { getSeedEncryptionKey } from "@/chain/impl/config.js";
import { decryptSeed, seedFingerprint, loadedSeedFingerprint } from "@/chain/seed/master-seed.js";
import { deriveArgon2Key, combineAndStretchKey } from "@/chain/seed/passphrase.js";
import { encryptWithVaultKey, verifyVaultPassphrase } from "@/chain/seed/vault.js";

export const MIN_PASSPHRASE_LENGTH = 12;

export type VaultProofRefusalCode = "passphrase_too_short" | "no_seed" | "seed_unreadable" | "verifier_exists" | "round_trip_failed" | "write_race";

export class VaultProofRefused extends Error {
  readonly code: VaultProofRefusalCode;
  constructor(code: VaultProofRefusalCode, message: string) {
    super(message);
    this.name = "VaultProofRefused";
    this.code = code;
  }
}

export interface WriteVerifierResult {
  outcome: "would_write" | "written" | "already_proven";
  fingerprint: string;
}

const passphraseSchema = z.string().min(MIN_PASSPHRASE_LENGTH);

/** Reads the one seed row and proves it decrypts to its own fingerprint. */
async function readProvenSeedRow(): Promise<{ fingerprint: string; vaultVerifier: string | null }> {
  const rows = await prisma.cryptoConfig.findMany({ select: { id: true, encryptedMasterSeed: true, seedFingerprint: true, vaultVerifier: true } });
  const row = rows[0];
  if (rows.length !== 1 || !row || row.id !== 1) {
    throw new VaultProofRefused("no_seed", `crypto_config holds ${rows.length} row(s); expected exactly one (import the seed first)`);
  }
  let seed: Buffer;
  try {
    seed = decryptSeed(row.encryptedMasterSeed, getSeedEncryptionKey());
  } catch {
    throw new VaultProofRefused("seed_unreadable", "the stored seed does not decrypt with SEED_ENCRYPTION_KEY");
  }
  const fp = seedFingerprint(seed);
  seed.fill(0);
  if (fp !== row.seedFingerprint) {
    throw new VaultProofRefused("seed_unreadable", "the stored seed decrypts to a different fingerprint than its row says");
  }
  return { fingerprint: row.seedFingerprint, vaultVerifier: row.vaultVerifier };
}

/**
 * Writes crypto_config.vault_verifier = AES-GCM(vaultKey, fingerprint), where
 * vaultKey = HKDF(SEED_ENCRYPTION_KEY XOR Argon2id(passphrase)). Never
 * overwrites an existing verifier: the same passphrase → already_proven, any
 * other → refused. The new verifier is opened again with a fresh derivation
 * BEFORE it is written, and the write is conditional on the row still holding
 * this seed and no verifier (one row, or it rolls back).
 */
export async function writeVaultVerifier(input: { passphrase: string; apply: boolean }): Promise<WriteVerifierResult> {
  if (!passphraseSchema.safeParse(input.passphrase).success) {
    throw new VaultProofRefused("passphrase_too_short", `the passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
  const { fingerprint, vaultVerifier: existing } = await readProvenSeedRow();

  if (existing !== null) {
    if (await verifyVaultPassphrase(input.passphrase, existing, fingerprint)) return { outcome: "already_proven", fingerprint };
    throw new VaultProofRefused("verifier_exists", "a vault verifier is already stored for this seed under a different passphrase — refusing to overwrite it");
  }

  const vaultKey = combineAndStretchKey(getSeedEncryptionKey(), await deriveArgon2Key(input.passphrase));
  const verifier = encryptWithVaultKey(fingerprint, vaultKey);
  vaultKey.fill(0);
  if (!(await verifyVaultPassphrase(input.passphrase, verifier, fingerprint))) {
    throw new VaultProofRefused("round_trip_failed", "the new verifier did not open with the same passphrase — nothing written");
  }
  if (!input.apply) return { outcome: "would_write", fingerprint };

  await prisma.$transaction(async (tx) => {
    const updated = await tx.cryptoConfig.updateMany({ where: { id: 1, seedFingerprint: fingerprint, vaultVerifier: null }, data: { vaultVerifier: verifier } });
    if (updated.count !== 1) throw new VaultProofRefused("write_race", `the conditional write hit ${updated.count} row(s), not 1 — rolled back`);
    const back = await tx.cryptoConfig.findUniqueOrThrow({ where: { id: 1 }, select: { vaultVerifier: true } });
    if (back.vaultVerifier !== verifier) throw new VaultProofRefused("write_race", "the stored verifier is not the one written — rolled back");
  });
  logger.info({ actor: "cli:prove-vault", action: "vaultVerifierWrite", result: "written", fingerprint }, "vault verifier written");
  return { outcome: "written", fingerprint };
}

/** The one seed row's shape, read WITHOUT decrypting anything. */
async function readSeedRowShape(): Promise<{ fingerprint: string; vaultVerifier: string | null } | null> {
  const rows = await prisma.cryptoConfig.findMany({ select: { id: true, seedFingerprint: true, vaultVerifier: true }, take: 2 });
  const row = rows[0];
  if (rows.length !== 1 || !row || row.id !== 1 || !fingerprintShape.safeParse(row.seedFingerprint).success) return null;
  return { fingerprint: row.seedFingerprint, vaultVerifier: row.vaultVerifier };
}

const fingerprintShape = z.string().regex(/^[0-9a-f]{8}$/);

/**
 * /v1/health reader (contract v1.1 A9). /health is unauthenticated and polled
 * every few seconds, so this NEVER loads or decrypts the seed and NEVER touches
 * master-seed.ts's wipe timer (review Q low, p0/g4 84ee6ba: calling
 * loadMasterSeed here kept the plaintext resident and the 60-minute wipe from
 * ever firing). One indexed read of crypto_config, then:
 *   - a seed IS cached in this process → "ready" only if its fingerprint equals
 *     the row's (a process still holding the pre-import seed is "unavailable");
 *   - nothing cached → "ready" when exactly one well-formed row exists, it
 *     equals SAMAPAY_EXPECTED_SEED_FINGERPRINT when that is set, and
 *     SEED_ENCRYPTION_KEY is present and 32 bytes.
 * Not knowable without decrypting, and therefore NOT claimed: that the stored
 * blob opens with the configured key. The first real derivation
 * (loadMasterSeed) verifies that and refuses loudly if it does not.
 */
export async function derivationStatus(): Promise<"ready" | "unavailable"> {
  try {
    const row = await readSeedRowShape();
    if (!row) return "unavailable";
    const loaded = loadedSeedFingerprint();
    if (loaded !== null) return loaded === row.fingerprint ? "ready" : "unavailable";
    const expected = process.env.SAMAPAY_EXPECTED_SEED_FINGERPRINT;
    if (expected !== undefined && expected !== "" && (!fingerprintShape.safeParse(expected).success || expected !== row.fingerprint)) return "unavailable";
    getSeedEncryptionKey();
    return "ready";
  } catch {
    return "unavailable";
  }
}

/**
 * /v1/health reader (contract v1.1 A9): "proven" = derivation is ready AND a
 * vault verifier is stored (see the header for why that implies an unlock
 * already succeeded against it). Otherwise "unproven".
 */
export async function vaultStatus(): Promise<"proven" | "unproven"> {
  try {
    const row = await readSeedRowShape();
    if (!row || (await derivationStatus()) !== "ready") return "unproven";
    return row.vaultVerifier === null ? "unproven" : "proven";
  } catch {
    return "unproven";
  }
}
