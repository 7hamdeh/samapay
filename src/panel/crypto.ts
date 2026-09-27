// Panel primitives. Chosen so that a database leak is not a session leak and a
// log line is never a credential.
import { createHash, createHmac, createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";

/** Base64url with no padding — the shape every token in this panel uses. */
export function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}
export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
export function hmacSha256(key: string | Buffer, input: string): Buffer {
  return createHmac("sha256", key).update(input).digest();
}
export function hmacSha256Hex(key: string | Buffer, input: string): string {
  return hmacSha256(key, input).toString("hex");
}

/** Constant-time compare that refuses a length mismatch instead of short-circuiting. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex")); }
  catch { return false; } // non-hex on either side is a mismatch, not a crash
}
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8"); const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** A 6-digit code from rejection-free randomness (200 bits of entropy per draw
 *  would be overkill; the anti-enumeration work is done by argon2 + the
 *  attempt brake, not by the alphabet). */
export function randomNumericCode(digits = 6): string {
  const mod = 10 ** digits;
  const limit = Math.floor(0x100000000 / mod) * mod; // rejection boundary, 32-bit source
  let draw = 0;
  for (;;) {
    draw = randomBytes(4).readUInt32BE(0);
    if (draw < limit) break;
  }
  return String(draw % mod).padStart(digits, "0");
}

/** Codes are argon2'd with the library's defaults — the SAME treatment a key
 *  gets (src/keys/generate.ts:23-25). A 6-digit code is 20 bits: sha256 would
 *  be brute-forceable offline by anyone holding a read of this table. */
export async function hashSecret(plaintext: string): Promise<string> {
  return argon2Hash(plaintext);
}
export async function verifySecret(hashed: string, plaintext: string): Promise<boolean> {
  try { return await argon2Verify(hashed, plaintext); } catch { return false; }
}

// ── AEAD for the optional 2FA secret ───────────────────────────────────────
// Mirrors src/keys/webhook-secret.ts exactly: an HKDF-SHA256 subkey of
// SEED_ENCRYPTION_KEY with its OWN info string, ciphertext stored as
// "v1:<base64>", and a hard refusal on any column that does not start with the
// prefix. The info string is different on purpose: "a TOTP blob and a
// webhook-secret blob are never decryptable by each other's key" is the same
// domain separation webhook-secret.ts:9-11 argues for.
const TOTP_HKDF_INFO = "samapay-panel-totp-v1";
const TOTP_PREFIX = "v1:";

function totpKey(seedEncryptionKey: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(seedEncryptionKey, "utf8"), Buffer.alloc(32), Buffer.from(TOTP_HKDF_INFO, "utf8"), 32));
}

export function encryptTotpSecret(seedEncryptionKey: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", totpKey(seedEncryptionKey), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${TOTP_PREFIX}${Buffer.concat([iv, ct, cipher.getAuthTag()]).toString("base64")}`;
}

/** Returns null when the value is not a v1 blob or does not decrypt. NEVER
 *  falls back to treating the column as plaintext — a silent fallback is how a
 *  ciphertext gets signed with, or a TOTP check gets bypassed by, a corrupt row. */
export function decryptTotpSecret(seedEncryptionKey: string, stored: string): string | null {
  if (!stored.startsWith(TOTP_PREFIX)) return null;
  try {
    const raw = Buffer.from(stored.slice(TOTP_PREFIX.length), "base64");
    const iv = raw.subarray(0, 12), tag = raw.subarray(raw.length - 16), ct = raw.subarray(12, raw.length - 16);
    const d = createDecipheriv("aes-256-gcm", totpKey(seedEncryptionKey), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}
