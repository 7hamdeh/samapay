// HMAC-SHA256 webhook signing — the SamaPrime contract (lib/webhooks/signature.ts)
// with SamaPay's own header name:
//   X-SamaPay-Signature: t=<unix seconds>,v1=<hex>
//   signature = HMAC-SHA256(secret, `${t}.${rawBody}`)   the timestamp is signed
//   verification is timing-safe and rejects |now - t| > 300 s
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "X-SamaPay-Signature";
export const EVENT_HEADER = "X-SamaPay-Event";
export const TOLERANCE_SECONDS = 300;

export function signPayload(secret: string, rawBody: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

export function verifySignature(secret: string, rawBody: string, header: string | null | undefined, now = Math.floor(Date.now() / 1000)): boolean {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!m) return false;
  const t = Number(m[1]);
  if (!Number.isFinite(t) || Math.abs(now - t) > TOLERANCE_SECONDS) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected, "hex"), b = Buffer.from(m[2] as string, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
