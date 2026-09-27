// WEBHOOK SECRETS — generated here, stored ONLY as AEAD ciphertext, decrypted
// only by the dispatcher at signing time. The plaintext exists once: in the
// issuing CLI's output (src/keys/issue.ts returns it, scripts/issue-key.ts
// prints it to a TTY and nowhere else).
//
// AEAD: the repo's existing AES-256-GCM helper (encryptSeed/decryptSeed in
// src/chain/seed/master-seed.ts — IV ‖ tag ‖ ciphertext, base64) under a
// SUB-KEY of SEED_ENCRYPTION_KEY: HKDF-SHA256(info "samapay-webhook-secret-v1").
// The sub-key is DOMAIN SEPARATION: a webhook-secret blob and a seed blob are
// never decryptable by each other's key, so no code path that handles one
// can be pointed at the other. No seed code is changed; the helper is called
// as-is.
//
// Stored form: "v1:" + base64. Anything else in the column (a legacy raw
// value, a truncated blob, the wrong key) is UNREADABLE and the dispatcher
// refuses to sign with it — it never falls back to signing with the column's
// raw bytes, which was the defect this module closes.
import crypto from "node:crypto";
import { decryptSeed, encryptSeed } from "@/chain/seed/master-seed.js";
import { getSeedEncryptionKey } from "@/chain/impl/config.js";

const VERSION_PREFIX = "v1:";
const HKDF_INFO = "samapay-webhook-secret-v1";
export const WEBHOOK_SECRET_PREFIX = "whsec_";

export class WebhookSecretUnreadable extends Error {
  constructor(reason: string) { super(`webhook secret unreadable: ${reason}`); this.name = "WebhookSecretUnreadable"; }
}

function subKey(): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", getSeedEncryptionKey(), Buffer.alloc(0), HKDF_INFO, 32));
}

/** 32 random bytes, base64url: `whsec_` + 43 chars. The receiver uses the whole string as the HMAC key. */
export function generateWebhookSecret(): string {
  return WEBHOOK_SECRET_PREFIX + crypto.randomBytes(32).toString("base64url");
}

export function encryptWebhookSecret(plaintext: string): string {
  if (!plaintext.startsWith(WEBHOOK_SECRET_PREFIX)) throw new Error("refusing to store a webhook secret that was not generated here");
  return VERSION_PREFIX + encryptSeed(Buffer.from(plaintext, "utf8"), subKey());
}

export function decryptWebhookSecret(stored: string): string {
  if (!stored.startsWith(VERSION_PREFIX)) throw new WebhookSecretUnreadable("not a v1 ciphertext");
  let plain: string;
  try { plain = decryptSeed(stored.slice(VERSION_PREFIX.length), subKey()).toString("utf8"); }
  catch { throw new WebhookSecretUnreadable("authentication failed (wrong key or tampered blob)"); }
  if (!plain.startsWith(WEBHOOK_SECRET_PREFIX)) throw new WebhookSecretUnreadable("decrypted value has the wrong shape");
  return plain;
}

/**
 * The hostnames `validateWebhookUrl` accepts for a PLAIN http target. Named
 * once and imported by `src/net/webhook-target.ts`, which used to restate this
 * list: a webhook to loopback is a normal shape on this box (MNTAD and SamaPay
 * share it — `scripts/issue-key.ts`'s own runbook line is
 * `--webhook-url "http://127.0.0.1:3033/api/webhooks/samapay/<credentialId>"`),
 * and the two readers of that fact must not be able to drift.
 */
export const WEBHOOK_LOOPBACK_HOSTNAMES: readonly string[] = ["127.0.0.1", "localhost", "[::1]"];

/**
 * The hosts the DISPATCHER may POST to over plain http. The operator's door
 * (`PANEL_WEBHOOK_ALLOWED_HOSTNAMES`, the same variable the panel reads when it
 * saves a URL) UNION `WEBHOOK_LOOPBACK_HOSTNAMES`.
 *
 * The union is not a widening of what a MERCHANT can aim us at: nothing in
 * `src/panel/` uses this function, and a panel save still goes through
 * `assertWebhookTargetUrl` with the operator list ALONE, so a loopback target
 * this accepts can only be a row the CLI — Ibrahim's hand — wrote. What the
 * union buys is that wiring the guard at send time cannot change one delivery
 * that works today, which is the only way a change to this file can be merged
 * while the crediting path is live.
 */
export function webhookEgressAllowlist(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const configured = (env.PANEL_WEBHOOK_ALLOWED_HOSTNAMES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return Object.freeze([...new Set([...configured, ...WEBHOOK_LOOPBACK_HOSTNAMES])]);
}

/**
 * https anywhere; plain http ONLY to a loopback host (MNTAD and SamaPay share
 * the box in slice 1). No credentials in the URL. Returns the normalised URL.
 */
export function validateWebhookUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`webhook URL does not parse: ${raw}`); }
  const loopback = WEBHOOK_LOOPBACK_HOSTNAMES.includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new Error("webhook URL must be https (plain http only to a loopback host)");
  if (u.username || u.password) throw new Error("webhook URL must not carry credentials");
  return u.toString();
}
