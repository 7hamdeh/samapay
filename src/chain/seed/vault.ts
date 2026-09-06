// Master seed vault (Phase 2A-FAST). Gates SIGNING operations (withdrawal
// send, auto-sweep) behind an admin-entered passphrase, on top of the
// existing SEED_ENCRYPTION_KEY. See docs/SECURITY.md "Vault + Passphrase"
// for the full threat model and lib/crypto/seed/master-seed.ts's
// CryptoConfig.vaultVerifier comment for why this does NOT change how the
// base master seed is stored/decrypted — address derivation
// (getOrCreateAddress) is unaffected by vault lock state, only
// signing is gated.
import crypto from "node:crypto";
import { prisma } from "@/db/client.js";
import { logger } from "@/log.js";
import { loadMasterSeed } from "@/chain/seed/master-seed.js";
import { getSeedEncryptionKey } from "@/chain/impl/config.js";
import { deriveArgon2Key, combineAndStretchKey } from "@/chain/seed/passphrase.js";
import { cacheHotWalletAddresses } from "@/chain/impl/hot-wallet.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const AAD = Buffer.from("salamwallet-vault-v1", "utf8");

export class VaultError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}

export class VaultNotConfiguredError extends VaultError {
  constructor() {
    super(
      "vault_not_configured",
      "No vault verifier is configured. Run `pnpm exec tsx scripts/migrate-seed-to-vault.ts` once to set an admin passphrase.",
    );
  }
}

export class VaultInvalidPassphraseError extends VaultError {
  constructor() {
    super("vault_invalid_passphrase", "Incorrect passphrase.");
  }
}

export class VaultLockedError extends VaultError {
  constructor() {
    super("vault_locked", "System locked, admin unlock required.");
  }
}

export class VaultRateLimitedError extends VaultError {
  constructor(retryAfterMs: number) {
    super("vault_rate_limited", `Too many attempts. Try again in ${Math.ceil(retryAfterMs / 1000)}s.`);
  }
}

function getUnlockTtlMs(): number {
  // parseFloat, not parseInt: a fractional value like "0.5" (30s, used by
  // scripts/verify-vault.ts to test auto-lock without a real multi-hour
  // wait) truncates to integer 0 under parseInt, which then silently fell
  // through to the 240-minute default instead of the intended short TTL —
  // caught by that verify script failing "Auto-locks after TTL expiry".
  const minutes = Number.parseFloat(process.env.CRYPTO_UNLOCK_TTL_MINUTES ?? "240");
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 240) * 60 * 1000;
}

/** Encrypts `plaintext` with a vault key. Exported for scripts/migrate-seed-to-vault.ts. */
export function encryptWithVaultKey(plaintext: string, vaultKey: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, vaultKey, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

function decryptWithVaultKey(blob: string, vaultKey: Buffer): string {
  const raw = Buffer.from(blob, "base64");
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, vaultKey, iv);
  decipher.setAAD(AAD);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

// --- In-memory vault state. Locked on every process start, by design. ---
//
// Stored on globalThis, not a plain module-scope `let` — Next.js App
// Router bundles this module independently into more than one server
// chunk (confirmed by inspecting .next/server: the Server Action
// co-located with app/admin/unlock/page.tsx gets its own inlined copy,
// while app/admin/layout.tsx and app/api/admin/vault-status/route.ts
// share a *different* chunk). A plain module-scope variable is therefore
// NOT a real process-wide singleton here — each bundle copy gets its own
// disconnected `unlockedSeed`, so an unlock written by one copy is
// invisible to a read from another, even though both run in the same
// pm2 process. globalThis is genuinely one object per Node.js process
// regardless of how many separate compiled copies of this module exist,
// which is exactly the same reasoning behind lib/db/client.ts's Prisma
// singleton (that one only needs the globalThis guard in dev, for
// hot-reload; this one needs it in production too, since the duplication
// here comes from webpack's per-entry bundling, not hot-reload). Still
// resets to fully locked on every new process (pm2 restart, deploy,
// crash) — globalThis doesn't survive a process exiting, so the
// documented "locked by default on every process start" invariant
// (docs/SECURITY.md "Threat model: seed vault + passphrase") is
// unaffected by this change.
interface VaultGlobalState {
  unlockedSeed: Buffer | null;
  unlockedAt: number | null;
  expiresAt: number | null;
  autoLockTimer: ReturnType<typeof setTimeout> | null;
  attemptsByIp: Map<string, { count: number; windowStart: number }>;
}

declare global {
  var __salamVaultState: VaultGlobalState | undefined;
}

function vaultState(): VaultGlobalState {
  if (!globalThis.__salamVaultState) {
    globalThis.__salamVaultState = {
      unlockedSeed: null,
      unlockedAt: null,
      expiresAt: null,
      autoLockTimer: null,
      attemptsByIp: new Map(),
    };
  }
  return globalThis.__salamVaultState;
}

function doLock(): void {
  const state = vaultState();
  state.unlockedSeed?.fill(0);
  state.unlockedSeed = null;
  state.unlockedAt = null;
  state.expiresAt = null;
  if (state.autoLockTimer) {
    clearTimeout(state.autoLockTimer);
    state.autoLockTimer = null;
  }
}

export function isUnlocked(): boolean {
  return vaultState().unlockedSeed !== null;
}

export interface VaultStatus {
  unlocked: boolean;
  unlockedAt: string | null;
  expiresAt: string | null;
}

export function getVaultStatus(): VaultStatus {
  const state = vaultState();
  return {
    unlocked: isUnlocked(),
    unlockedAt: state.unlockedAt ? new Date(state.unlockedAt).toISOString() : null,
    expiresAt: state.expiresAt ? new Date(state.expiresAt).toISOString() : null,
  };
}

// Simple in-memory per-IP rate limit, matching this module's existing
// "in-memory is an accepted MVP tradeoff" pattern (scanner cursor, seed
// cache, RPC pool cooldowns all work the same way — see
// docs/INVARIANTS.md "Crypto"). Resets on process restart, which is fine:
// a restart already re-locks the vault, so there's nothing for a
// restart-reset rate limit to protect that a locked vault doesn't already.
// Lives on the same globalThis-backed state as the unlock state itself,
// for the same cross-bundle-copy reason (see vaultState() above) — a
// module-scope Map here would undercount attempts made through a
// different compiled copy of this file.
const MAX_ATTEMPTS = 3;
const WINDOW_MS = 15 * 60 * 1000;

function checkRateLimit(ip: string): void {
  const attemptsByIp = vaultState().attemptsByIp;
  const now = Date.now();
  const entry = attemptsByIp.get(ip);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    attemptsByIp.set(ip, { count: 0, windowStart: now });
    return;
  }
  if (entry.count >= MAX_ATTEMPTS) {
    throw new VaultRateLimitedError(entry.windowStart + WINDOW_MS - now);
  }
}

function recordAttempt(ip: string): void {
  const entry = vaultState().attemptsByIp.get(ip);
  if (entry) entry.count += 1;
}

function scheduleAutoLock(ttlMs: number): void {
  const state = vaultState();
  if (state.autoLockTimer) clearTimeout(state.autoLockTimer);
  state.autoLockTimer = setTimeout(() => {
    logger.warn({ action: "vaultAutoLock" }, "Seed vault auto-locked after TTL expiry");
    doLock();
  }, ttlMs);
  state.autoLockTimer.unref();
}

/**
 * Verifies the passphrase (test-decrypts CryptoConfig.vaultVerifier and
 * checks the result against the stored seedFingerprint), then loads the
 * master seed via the existing single-key path and caches it here with a
 * TTL. Rate-limited per IP: 3 attempts / 15 min.
 */
export async function unlockVault(passphrase: string, ip: string): Promise<VaultStatus> {
  checkRateLimit(ip);

  const config = await prisma.cryptoConfig.findUnique({ where: { id: 1 } });
  if (!config?.vaultVerifier) {
    throw new VaultNotConfiguredError();
  }

  const seedEncryptionKey = getSeedEncryptionKey();
  const argon2Key = await deriveArgon2Key(passphrase);
  const vaultKey = combineAndStretchKey(seedEncryptionKey, argon2Key);

  let decrypted: string;
  try {
    decrypted = decryptWithVaultKey(config.vaultVerifier, vaultKey);
  } catch {
    recordAttempt(ip);
    throw new VaultInvalidPassphraseError();
  }

  if (decrypted !== config.seedFingerprint) {
    recordAttempt(ip);
    throw new VaultInvalidPassphraseError();
  }

  const seed = await loadMasterSeed();
  const state = vaultState();
  state.unlockedSeed = Buffer.from(seed); // independent copy — this module wipes its own on lock, without touching master-seed.ts's own cache/TTL
  state.unlockedAt = Date.now();
  const ttlMs = getUnlockTtlMs();
  state.expiresAt = state.unlockedAt + ttlMs;
  scheduleAutoLock(ttlMs);

  state.attemptsByIp.delete(ip);
  logger.info({ action: "vaultUnlocked", expiresAt: new Date(state.expiresAt).toISOString() }, "Seed vault unlocked");

  // Derive + cache the hot wallet addresses for locked-state display
  // (docs/SECURITY.md "Hot Wallet Isolation"). Best-effort: a failure here
  // must never fail the unlock itself — the vault is already unlocked and
  // usable for signing at this point regardless of whether this cache
  // write succeeds.
  cacheHotWalletAddresses(state.unlockedSeed).catch((error) => {
    logger.error({ action: "hotWalletAddressCacheFailed", err: error }, "Failed to cache hot wallet addresses after unlock");
  });

  return getVaultStatus();
}

export function lockVault(): void {
  doLock();
  logger.info({ action: "vaultLocked" }, "Seed vault manually locked");
}

/** Only for signing code paths (withdrawal-sender, auto-sweeper). Throws VaultLockedError if locked. */
export function getVaultSeed(): Buffer {
  const seed = vaultState().unlockedSeed;
  if (!seed) {
    throw new VaultLockedError();
  }
  return seed;
}

/** Test/shutdown helper, mirrors master-seed.ts#wipeMasterSeedCache. */
export function wipeVaultCache(): void {
  doLock();
}
