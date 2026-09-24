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
/** seedFingerprint(cachedSeed), computed once when it was loaded and verified. */
let cachedFingerprint: string | null = null;
let wipeTimer: ReturnType<typeof setTimeout> | null = null;
/** When the current wipe timer was (re)armed — observable so a test can prove a reader never re-arms it. */
let wipeArmedAt: number | null = null;

function scheduleWipe(): void {
  if (wipeTimer) clearTimeout(wipeTimer);
  wipeArmedAt = Date.now();
  wipeTimer = setTimeout(() => {
    cachedSeed?.fill(0);
    cachedSeed = null;
    cachedFingerprint = null;
    wipeTimer = null;
    wipeArmedAt = null;
  }, SEED_MEMORY_TTL_MS);
  wipeTimer.unref();
}

/**
 * Loads the decrypted master seed, from the in-memory cache if present
 * (resetting the inactivity timer), otherwise from CryptoConfig + decrypt +
 * fingerprint verification. Throws SeedNotConfiguredError if no CryptoConfig
 * row exists yet — run the CLI generator first.
 *
 * THE CACHE IS CHECKED AGAINST THE ROW ON EVERY CALL (one primary-key read of
 * seed_fingerprint). scripts/import-master-seed.ts replaces the row while the
 * API may be running; before this check a running process kept deriving from
 * the OLD seed for as long as it stayed busy (the TTL resets on every use),
 * while /health read the new row and said "ready" (review Q, p0/g4 fb3cc3e).
 * On mismatch the cache is dropped and the row is decrypted + verified afresh.
 * The superseded buffer is NOT zeroed here: a concurrent caller may still hold
 * it across an await, and zeroing it would make that caller derive from 32
 * zero bytes instead of failing — it is simply released to the GC.
 */
export async function loadMasterSeed(): Promise<Buffer> {
  if (cachedSeed) {
    const row = await prisma.cryptoConfig.findUnique({ where: { id: 1 }, select: { seedFingerprint: true } });
    if (row && row.seedFingerprint === cachedFingerprint) {
      scheduleWipe();
      return cachedSeed;
    }
    cachedSeed = null;
    cachedFingerprint = null;
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
  cachedFingerprint = config.seedFingerprint;
  scheduleWipe();
  return cachedSeed;
}

/**
 * The fingerprint of the seed THIS PROCESS currently holds (loaded and
 * verified), or null if none is loaded. For /health: compared with the row.
 */
export function loadedSeedFingerprint(): string | null {
  return cachedSeed ? cachedFingerprint : null;
}

/** Test/diagnostic view of the cache: never the seed, only whether one is held and when its wipe was armed. */
export function seedCacheState(): { loaded: boolean; wipeArmedAt: number | null } {
  return { loaded: cachedSeed !== null, wipeArmedAt };
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
  wipeArmedAt = null;
  cachedSeed?.fill(0);
  cachedSeed = null;
  cachedFingerprint = null;
}
