// =====================================================================
// *** IS THIS URL A LEGITIMATE WEBHOOK TARGET FOR OUR EGRESS? ***
// =====================================================================
// The webhook target is a string the key's owner chose, and
// `src/webhooks/dispatch.ts` POSTs our signed events to it, on a retry
// schedule, from this box. Two rules have to be true about it and nothing
// in this repo currently enforces both in one place:
//
//   (a) SHAPE — the rule already in `src/keys/webhook-secret.ts`
//       `validateWebhookUrl`: https anywhere, plain http ONLY to
//       127.0.0.1 / localhost / [::1], no credentials in the URL.
//   (b) ADDRESS — the rule ported from MNTAD into
//       `src/net/outbound-address-guard.ts`: resolve the host and refuse
//       loopback / RFC1918 / CGNAT / link-local (the 169.254.169.254
//       metadata endpoint) / TEST-NET / multicast / reserved, judging
//       EVERY DNS answer, not the first.
//
// (a) alone is the defect: `https://169.254.169.254/` satisfies it
// completely — it is https — and the delivery row's status,
// last_status_code and last_error then report back what was there. (b)
// alone is not enough either: the ported guard is https-only by design
// and would refuse the http-to-loopback target this deployment actually
// uses. This file composes them, in that order, and owns the composition
// ONLY — the blocklist stays where it is, so there is one copy of the
// rule and not two that can drift apart.
//
// ⚠️ THE LOOPBACK DOOR IS OPERATOR CONFIG, NEVER MERCHANT INPUT.
// `allowHostnames` is passed by the CALLER from env config
// (`PANEL_WEBHOOK_ALLOWED_HOSTNAMES`, comma-separated, parsed once in
// `src/panel/config.ts` and threaded through the panel route into
// `panelSetWebhook`). No module in `src/net/` reads `process.env`, so the
// door cannot be opened from a request body, a query param, a header or a
// `ClientKey` row. SamaPay needs the door because MNTAD and SamaShare share
// this box and talk over `http://127.0.0.1:3090`, so a loopback webhook
// target is a normal deployment shape here — but it is allowed by operator
// decision, per host, and refused by default.
//
// ─────────────────────────────────────────────────────────────────────
// WHERE THIS MUST BE CALLED (two places; one is not the other):
//
//  1. AT SAVE TIME — `src/panel/webhook.ts` `panelSetWebhook()` calls it
//     before writing `webhookUrl`, and `src/keys/issue.ts` (line ~57,
//     today `validateWebhookUrl`) should call it for the same reason the
//     CLI and the admin route accept a URL. Saves are cheap and the
//     merchant learns now, not as a mysterious `exhausted` later.
//     ⚠️ THIS IS NOT THE SECURITY BOUNDARY.
//  2. AT DISPATCH TIME — `src/webhooks/dispatch.ts` `attemptDelivery()`,
//     after the `target` row is read and BEFORE the `fetchImpl` call, on
//     `target.webhookUrl` as stored. DNS at save time is not DNS at send
//     time, and the dispatcher re-reads the key's CURRENT stored URL on
//     every attempt, so the string being fetched is re-checked as late as
//     it can be. WIRED 2026-09-27 (review MEDIUM: the test button guarded
//     key X's URL while dispatch POSTed elsewhere and retried unguarded);
//     `scripts/verify-dispatch-egress.ts` owns the proof. Its allowlist is
//     `webhookEgressAllowlist()` in src/keys/webhook-secret.ts — the
//     operator door UNION the loopback hosts `validateWebhookUrl` has always
//     accepted, because a send-time refusal of a CLI-minted loopback target
//     would stop the crediting path on the next restart.
//
// ⚠️ AND NEITHER CALL CLOSES THE REDIRECT HOLE. A pre-flight check on the
// URL is worthless if the transport then follows a 302 to
// 169.254.169.254; the only thing that closes it is `redirect: "manual"`
// plus a refusal of the 3xx, which is what `guardedFetch` does and what
// dispatch's own inline `fetch(u, { redirect: "manual" })` half-does (it
// does not follow — so no hop happens — but it treats a 3xx as an ordinary
// failed status rather than as a refusal). See the report in
// `src/net/outbound-address-guard.ts`'s header.
//
// WHAT THE ANSWERS CARRY: `code` is stable and machine-readable — it is
// what goes into an audit row and a panel message, so never rename one
// without treating it as an API change. `detail` is a human sentence:
// NEVER more of the URL than the host, because path and query can carry
// the merchant's own token and the blocklist label tells an attacker
// nothing they can use. (`validateWebhookUrl`'s current parse failure
// throws with the WHOLE raw URL interpolated into the message; this file
// deliberately does not copy that.)
import {
  assertOutboundUrlAllowed,
  OutboundAddressRefusedError,
  type AddressResolver,
  type OutboundRefusalReason,
} from "./outbound-address-guard.js";
import { WEBHOOK_LOOPBACK_HOSTNAMES } from "@/keys/webhook-secret.js";

/** Stable, machine-readable refusal codes. An API — renaming one is a
 *  breaking change to anything that branches on it. */
export type WebhookTargetCode =
  /** shape rules, this file's own */
  | "url_unparseable"
  | "url_credentials"
  | "not_https"
  /** address rules, from the ported guard */
  | "no_hostname"
  | "unresolvable"
  | "private_address"
  /** shape said plain http to a loopback host, but the operator never
   *  allowlisted that host — the loopback door is the only way through */
  | "loopback_not_allowlisted"
  /** the transport was asked, it redirected, and redirects are refused */
  | "redirect_refused";

export interface WebhookTargetOptions {
  /**
   * ⚠️ OPERATOR CONFIG ONLY — see the header. Absent or empty means no
   * loopback destination at all, which is the fail-closed default.
   * Matched against `url.hostname` verbatim, so an IPv6 literal carries
   * its brackets ("[::1]") and `new URL()` may have already rewritten an
   * IPv4-mapped address into hex groups.
   */
  readonly allowHostnames?: readonly string[];

  /** Test/embedding seam, forwarded to the guard. Defaults to `node:dns`. */
  readonly resolveAddresses?: AddressResolver;
}

export type WebhookTargetResult =
  | { readonly ok: true; readonly normalizedUrl: string }
  | { readonly ok: false; readonly code: WebhookTargetCode; readonly detail: string };

/**
 * The three hostnames `validateWebhookUrl` treats as loopback — IMPORTED, not
 * restated, so there is one list. (`"[::1]"` is bracketed because that is what
 * `url.hostname` holds for an IPv6 literal — measured on Node 24.14:
 *   new URL("http://[::1]:3090/").hostname  ->  "[::1]"
 * A plain "::1" here would never match, and the door would look open.)
 */
const LOOPBACK_HOSTNAMES: readonly string[] = WEBHOOK_LOOPBACK_HOSTNAMES;

/** The guard's reasons map 1:1 onto codes here; nothing is reworded. */
function reasonToCode(reason: OutboundRefusalReason): WebhookTargetCode {
  switch (reason) {
    case "not_https": return "not_https";
    case "no_hostname": return "no_hostname";
    case "unresolvable": return "unresolvable";
    case "private_address": return "private_address";
    case "redirect_refused": return "redirect_refused";
  }
}

/**
 * Judge a webhook target: shape first (the `validateWebhookUrl` rules),
 * then the resolved address (the ported guard's rules).
 *
 * Returns a result rather than throwing, because both of its callers are
 * request paths that need a code, not an exception type. It still lets a
 * genuinely unexpected error through: only `OutboundAddressRefusedError`
 * is converted, so a bug in the guard is not silently reported to the
 * merchant as "your URL is bad".
 *
 * @param url the raw target as stored or as submitted
 * @param options `allowHostnames` — OPERATOR config, see the header.
 */
export async function assertWebhookTargetUrl(url: string, options: WebhookTargetOptions = {}): Promise<WebhookTargetResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // ⚠️ the raw value is NOT echoed, in any part. It failed to parse, so
    // there is no host to name, and the string may be anything.
    return { ok: false, code: "url_unparseable", detail: "That is not a valid URL." };
  }

  const host = parsed.hostname;
  const loopback = LOOPBACK_HOSTNAMES.includes(host);

  // ── (a) SHAPE, in validateWebhookUrl's own order and wording ──
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    return {
      ok: false,
      code: "not_https",
      detail: `The webhook URL for ${host || "that host"} must be https; plain http is accepted only to a loopback host.`,
    };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, code: "url_credentials", detail: `The webhook URL for ${host} must not carry credentials.` };
  }
  if (!host) {
    return { ok: false, code: "no_hostname", detail: "That URL has no host." };
  }

  // ── (b) ADDRESS ──
  if (parsed.protocol === "https:") {
    // The guard owns every judgement past this point: the literal-IP
    // branch, DNS, "every answer not the first", the whole blocklist.
    // It is given the NORMALISED string, so what it checked and what the
    // caller will fetch are the same bytes (`normalizedUrl` below).
    //
    // `options` forwards whole, not field by field: `WebhookTargetOptions`
    // is deliberately the same shape as `OutboundGuardOptions`, and
    // rebuilding it with explicit properties would trip
    // `exactOptionalPropertyTypes` on an absent one (an omitted option is
    // not the same type as an option set to undefined in this repo).
    try {
      const checked = await assertOutboundUrlAllowed(parsed.toString(), options);
      return { ok: true, normalizedUrl: checked.toString() };
    } catch (e) {
      if (e instanceof OutboundAddressRefusedError) return { ok: false, code: reasonToCode(e.reason), detail: e.message };
      throw e;
    }
  }

  // Plain http survives (a) only for a loopback host. Whether it survives
  // here is the OPERATOR's decision and nothing else — and the answer to
  // an http request is in clear text, which is why a target this weak is
  // only ever sanctioned by hand, per host. The address check is skipped
  // for exactly the reason the guard itself skips it for an allowlisted
  // host: the host is known-private by definition (it is loopback), and
  // that is the whole point of the door.
  if (options.allowHostnames?.includes(host)) return { ok: true, normalizedUrl: parsed.toString() };
  return {
    ok: false,
    code: "loopback_not_allowlisted",
    detail: `Plain http to ${host} is refused: a loopback webhook target must be named in the operator's PANEL_WEBHOOK_ALLOWED_HOSTNAMES, and https is required for everything else.`,
  };
}
