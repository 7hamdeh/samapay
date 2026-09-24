// HMAC-SHA256 webhook signing — the SamaPrime contract (lib/webhooks/signature.ts)
// with SamaPay's own header name (API contract §7):
//   X-SamaPay-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>…]
//   signature = HMAC-SHA256(secret, `${t}.${rawBody}`)   the timestamp is signed
//   verification is timing-safe and rejects |now - t| > 300 s
//
// ROTATION: the signer may sign with several secrets (one v1 each, one t), and
// the receiver accepts the header if ANY v1 matches ANY secret it holds. So a
// secret can be rolled without a window where either side rejects the other.
// This file is the receiver algorithm MNTAD copies; keep the two identical.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "X-SamaPay-Signature";
export const EVENT_HEADER = "X-SamaPay-Event";
export const DELIVERY_HEADER = "X-SamaPay-Delivery";
export const TOLERANCE_SECONDS = 300;

const asList = (s: string | readonly string[]): readonly string[] => (typeof s === "string" ? [s] : s);
const hmacHex = (secret: string, t: number, rawBody: string) => createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");

export function signPayload(secret: string | readonly string[], rawBody: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const secrets = asList(secret);
  if (secrets.length === 0) throw new Error("signPayload: no secret");
  return [`t=${timestamp}`, ...secrets.map((s) => `v1=${hmacHex(s, timestamp, rawBody)}`)].join(",");
}

/**
 * The header must have exactly one `t=` and at least one `v1=`; parts of any
 * other scheme are ignored (forward-compatible), a malformed v1 simply never
 * matches. Two `t=` parts are refused outright — no picking the fresher one.
 */
export function verifySignature(secret: string | readonly string[], rawBody: string, header: string | null | undefined, now = Math.floor(Date.now() / 1000)): boolean {
  const parts = (header ?? "").split(",").map((p) => p.trim());
  const ts = parts.filter((p) => p.startsWith("t="));
  if (ts.length !== 1 || !/^t=\d{1,12}$/.test(ts[0] as string)) return false;
  const t = Number((ts[0] as string).slice(2));
  if (!Number.isSafeInteger(t) || Math.abs(now - t) > TOLERANCE_SECONDS) return false;
  const given = parts.filter((p) => /^v1=[0-9a-f]{64}$/.test(p)).map((p) => Buffer.from(p.slice(3), "hex"));
  if (given.length === 0) return false;
  let ok = false;
  // Every comparison runs: no early exit that times which secret matched.
  for (const s of asList(secret)) {
    const expected = Buffer.from(hmacHex(s, t, rawBody), "hex");
    for (const g of given) if (g.length === expected.length && timingSafeEqual(g, expected)) ok = true;
  }
  return ok;
}
