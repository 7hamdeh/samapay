// WHO IS THE CLIENT? — there is exactly one trustworthy answer on this box.
//
// pay-dashboard-review.md F1 measured that src/http/auth.ts:25-26 reads
// `x-forwarded-for[0]` FIRST, and nginx sets X-Real-IP without stripping a
// client-supplied X-Forwarded-For. So any IP derived from XFF is attacker-
// chosen, and every feature built on it (last_used_ip, the "was this you?"
// banner, an IP allowlist, a lockout) becomes a lie that LOOKS like evidence.
// The panel therefore reads X-Real-IP only, and returns null rather than
// guessing when it is absent.
import type { Context } from "hono";

export function clientIp(c: Context): string | null {
  const real = c.req.header("x-real-ip");
  if (!real) return null;
  const v = real.trim();
  // A malformed header is "no information", never a partial IP.
  if (!/^[0-9a-fA-F:.]{1,45}$/.test(v) || v.includes(" ")) return null;
  return v;
}

export function clientIpOrUnknown(c: Context): string {
  return clientIp(c) ?? "unknown";
}
