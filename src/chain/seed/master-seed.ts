// Master seed encrypt/decrypt/load. The decrypted seed lives ONLY in the
// module-scoped `cachedSeed` variable below — it is never logged, never
// returned in an API response, and never written to disk in plaintext.
// See docs/SECURITY.md for the full threat model.
import crypto from "node:crypto";
import { prisma } from "@/db/client.js";
import { getSeedEncryptionKey, SEED_MEMORY_TTL_MS } from "@/chain/impl/config.js";
import { SeedAlreadyConfiguredError, SeedDecryptFailedError, SeedFingerprintMismatchError, SeedNotConfiguredError } from "@/chain/impl/errors.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export function encryptSeed(seed: Buffer, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(seed), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

export function decryptSeed(encryptedBlob: string, key: Buffer): Buffer {
  const raw = Buffer.from(encryptedBlob, "base64");
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (cause) {
    throw new SeedDecryptFailedError(cause);
  }
}

/** First 8 hex chars of sha256(seed) — enough to verify, never enough to reconstruct. */
export function seedFingerprint(seed: Buffer): string {
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 8);
}

/** Used once by cli-generate.ts. Refuses to run if a CryptoConfig row already exists. */
export async function saveMasterSeedConfig(seed: Buffer): Promise<void> {
  const existing = await prisma.cryptoConfig.findUnique({ where: { id: 1 } });
  if (existing) {
    throw new SeedAlreadyConfiguredError();
  }
  const key = getSeedEncryptionKey();
  const encryptedMasterSeed = encryptSeed(seed, key);
  await prisma.cryptoConfig.create({
    data: { id: 1, encryptedMasterSeed, seedFingerprint: seedFingerprint(seed) },
  });
}

let cachedSeed: Buffer | null = null;
let wipeTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleWipe(): void {
  if (wipeTimer) clearTimeout(wipeTimer);
  wipeTimer = setTimeout(() => {
    cachedSeed?.fill(0);
    cachedSeed = null;
    wipeTimer = null;
  }, SEED_MEMORY_TTL_MS);
  wipeTimer.unref();
}

/**
 * Loads the decrypted master seed, from the in-memory cache if present
 * (resetting the inactivity timer), otherwise from CryptoConfig + decrypt +
 * fingerprint verification. Throws SeedNotConfiguredError if no CryptoConfig
 * row exists yet — run the CLI generator first.
 */
export async function loadMasterSeed(): Promise<Buffer> {
  if (cachedSeed) {
    scheduleWipe();
    return cachedSeed;
  }

  const config = await prisma.cryptoConfig.findUnique({ where: { id: 1 } });
  if (!config) {
    throw new SeedNotConfiguredError();
  }

  const key = getSeedEncryptionKey();
  const seed = decryptSeed(config.encryptedMasterSeed, key);
  if (seedFingerprint(seed) !== config.seedFingerprint) {
    seed.fill(0);
    throw new SeedFingerprintMismatchError();
  }

  cachedSeed = seed;
  scheduleWipe();
  return cachedSeed;
}

export interface CryptoConfigStatus {
  configured: boolean;
  fingerprint: string | null;
  createdAt: Date | null;
}

/** Admin-facing status — never returns anything that could reconstruct the seed. */
export async function getCryptoConfigStatus(): Promise<CryptoConfigStatus> {
  const config = await prisma.cryptoConfig.findUnique({ where: { id: 1 } });
  if (!config) {
    return { configured: false, fingerprint: null, createdAt: null };
  }
  return { configured: true, fingerprint: config.seedFingerprint, createdAt: config.createdAt };
}

/** Test/shutdown helper — not used in normal request handling. */
export function wipeMasterSeedCache(): void {
  if (wipeTimer) clearTimeout(wipeTimer);
  wipeTimer = null;
  cachedSeed?.fill(0);
  cachedSeed = null;
}
