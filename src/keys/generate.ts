// Key material. `sk_<env>_` + 40 base32 chars (200 bits). The first 12
// characters are the lookup prefix (SamaPrime's shape); the FULL key is
// argon2-hashed; the plaintext exists once, in the issuing response.
import { randomBytes } from "node:crypto";
import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import type { KeyEnvironment } from "@prisma/client";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"; // base32, lowercase, no ambiguity with 0/1/8/9 needed for typing
export const PREFIX_LENGTH = 12;

export function generatePlaintextKey(env: KeyEnvironment): string {
  const bytes = randomBytes(40);
  let body = "";
  for (let i = 0; i < 40; i++) body += ALPHABET[(bytes[i] as number) % 32];
  return `sk_${env}_${body}`;
}
export function keyPrefixOf(plaintext: string): string {
  return plaintext.slice(0, PREFIX_LENGTH);
}
export function keyLast4Of(plaintext: string): string {
  return plaintext.slice(-4);
}
export async function hashKey(plaintext: string): Promise<string> {
  return argon2Hash(plaintext);
}
export async function verifyKey(hashed: string, plaintext: string): Promise<boolean> {
  try { return await argon2Verify(hashed, plaintext); } catch { return false; }
}
