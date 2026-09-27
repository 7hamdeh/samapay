// Optional 2FA for panel accounts — RFC 6238 TOTP, implemented on node:crypto.
//
// WHY HAND-WRITTEN: the repo's dependency set is deliberately small (no otplib
// in package.json) and adding one to accept a third-party code is a supply
// decision, not a refactor. The algorithm is ~30 lines and fully specified.
// MNTAD already has a TOTP implementation (lib/auth/totp.ts) with a review
// history; this one matches its SHA-1/30 s/±1-step window so a merchant moving
// between the two products sees the same behaviour, and it keeps the secret
// AEAD-encrypted the same way the webhook secret is (see crypto.ts).
import { createHmac, randomBytes } from "node:crypto";
import { sha256Hex } from "./crypto.js";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_PERIOD_SEC = 30;
export const TOTP_DIGITS = 6;
/** ±1 step: two minutes of clock drift is the tolerance that keeps a passenger's
 *  phone usable without widening the window to "any recent code". */
export const TOTP_STEPS = 1;

export function generateTotpSecret(bytes = 20): string {
  const raw = randomBytes(bytes);
  let bits = "";
  for (const b of raw) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) out += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

export function decodeBase32(input: string): Buffer | null {
  const clean = input.replace(/=+$/g, "").replace(/[\s-]/g, "").toUpperCase();
  if (!clean.length || /[^A-Z2-7]/.test(clean)) return null;
  let bits = "";
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totpCode(secretBase32: string, counter: number, digits = TOTP_DIGITS): string | null {
  const key = decodeBase32(secretBase32);
  if (!key) return null;
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin = ((hmac[offset]! & 0x7f) << 24) | (hmac[offset + 1]! << 16) | (hmac[offset + 2]! << 8) | hmac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** Constant-time over the accepted window; a mismatch at step k is not allowed
 *  to leak which step matched by returning early. */
export function verifyTotpCode(secretBase32: string, code: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!/^[0-9]{6}$/.test(code)) return false;
  const step = Math.floor(nowSec / TOTP_PERIOD_SEC);
  let matched = 0;
  for (let d = -TOTP_STEPS; d <= TOTP_STEPS; d++) {
    const expected = totpCode(secretBase32, step + d);
    if (expected !== null && expected.length === code.length && timingSafeEq(expected, code)) matched |= 1 << (d + TOTP_STEPS);
  }
  return matched !== 0;
}

function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}

export function otpauthUri(label: string, secretBase32: string, issuer = "MNTAD Pay"): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SEC}`;
}

// ── backup codes ───────────────────────────────────────────────────────────
// 10 characters of base32 (50 bits) each, single-use. Stored as a plain sha256
// of the code: unlike a 6-digit TOTP step these are high-entropy, so an
// offline grind against the table is not the threat, and a sha256 lets
// "does this code match one of mine?" be an indexed lookup instead of an
// argon2 pass per candidate row.
const BACKUP_ALPHABET = BASE32_ALPHABET;
export function generateBackupCodes(count = 10): { plaintext: string[]; hashes: string[] } {
  const plaintext: string[] = [];
  for (let i = 0; i < count; i++) {
    let s = "";
    for (const b of randomBytes(10)) s += BACKUP_ALPHABET[b % 32];
    plaintext.push(`${s.slice(0, 5)}-${s.slice(5)}`);
  }
  return { plaintext, hashes: plaintext.map(normalizeBackup) };
}
export function normalizeBackup(code: string): string {
  return sha256Hex(code.replace(/[\s-]/g, "").toUpperCase());
}
