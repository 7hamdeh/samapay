// =====================================================================
// *** WHERE THE SERVER IS ALLOWED TO SEND A REQUEST. ***
// =====================================================================
// F2 of docs/scratch/merchant-surface-security-review-2026-08-31.md.
//
// A merchant types their provider's address into
// lib/actions/merchant-provider-credentials.ts. It was validated with
// `z.string().trim().url()` and nothing else, and the server then did
//
//     fetch(`${apiUrl}${path}`)          lib/providers/technorex-client.ts
//
// `z.string().url()` wraps `new URL()`, which is perfectly happy with
// `http://127.0.0.1:5432`, `http://169.254.169.254/latest/meta-data/`
// and any internal hostname. So a merchant could aim OUR server at OUR
// network and read the outcome off their own credentials screen, where
// six distinguishable statuses (unreachable / wrong_url /
// provider_error / invalid_token / ip_not_allowed / ok) made it a
// usable port scanner. The existing code is careful with SECRETS — it
// truncates and redacts both plaintexts — and that discipline is aimed
// at a different threat: it stops the response leaking OUR credentials,
// and says nothing about the merchant learning OUR topology.
//
// =====================================================================
// ⚠️ THE CHECK IS ON THE RESOLVED ADDRESS, NOT ON THE HOSTNAME.
// =====================================================================
// A hostname allowlist or a "does it look internal" string test is
// defeated by DNS: `evil.example` resolving to 169.254.169.254 passes
// every textual check ever written. So this resolves the name and
// judges EVERY answer it gets back — a name with one public and one
// private answer is refused, because which one `fetch` picks is not
// ours to decide.
//
// AND REDIRECTS ARE REFUSED RATHER THAN RE-CHECKED. `fetch` follows
// them by default, so a merchant-controlled host answering 302 ->
// 169.254.169.254 walks straight past a one-shot pre-flight check. Two
// ways to close that: re-validate on every hop, or refuse to hop. These
// are API calls to a documented endpoint that has no reason to
// redirect, so refusing is both simpler and stricter — and simpler is
// what survives being edited by somebody who has not read this comment.
//
// =====================================================================
// WHAT THIS IS NOT.
// =====================================================================
// *** IT IS NOT A COMPLETE SSRF DEFENCE AND MUST NOT BE DESCRIBED AS
// ONE. *** DNS can change between this check and the connection —
// classic rebinding — and closing that needs the socket pinned to the
// address that was validated, which Node's fetch does not expose. What
// this removes is the CHEAP, REPEATABLE probe: aim at an internal host,
// read the answer off your own screen, repeat. A rebinding attack is a
// different budget and it is worth saying so here rather than letting
// the next reader assume the door is shut.
//
// ─────────────────────────────────────────────────────────────────────
// SAMAPAY PORT — 2026-09-27, verbatim from SamaPrime's
// `lib/net/outbound-address-guard.ts` (268 lines, reviewed and verified
// there; its own suite is `scripts/verify-outbound-address-guard.ts`).
// The blocklist, the ranges, the resolve-then-judge-every-answer rule
// and the redirect refusal above ARE the reviewed artefact and were not
// re-improved here. Three seams were added, each marked `PORT(samapay)`
// at its definition, and none of them changes a decision this file makes:
//
//   1. `resolveAddresses` — inject the DNS lookup (tests only; the
//      default is the same `node:dns/promises` `lookup(host,{all:true})`).
//   2. `fetchImpl` in `guardedFetch` — inject the transport, matching
//      the seam `src/webhooks/dispatch.ts` already uses for the same
//      reason (a delivery must be provable without sending it).
//   3. `?? ""` on two regex-group reads, which exist only because this
//      repo compiles with `noUncheckedIndexedAccess`; see each site.
//
// THE SAME THREAT HERE, DIFFERENT INPUT: the address this service sends
// a request to is `ClientKey.webhookUrl` — a string the client's owner
// chose — and `attemptDelivery()` POSTs our signed, event-carrying
// payload to it from `src/webhooks/dispatch.ts`, on a retry schedule,
// for as long as seven more attempts. Aimed at `http://127.0.0.1:5432`
// that is us making authenticated-looking connections into our own
// network on someone else's orders; aimed at `169.254.169.254` it is us
// handing a client a request they cannot make from outside. The readout
// here is the delivery row (`status`, `last_status_code`, `last_error`)
// — retry vs exhausted vs delivered is a distinguishable outcome per
// target, which is the same port-scanner class as MNTAD's six-way
// status, even though nothing under `/v1` returns those columns today.
// The panel being built on this branch does render them to the key's
// owner: the party who chose the URL, exactly as in the MNTAD case.
//
// ⚠️ AND, EXACTLY AS THERE: the guard's `https:` rule is not this repo's
// webhook URL rule. Do NOT relax it here to let http through — the
// scheme decision for webhook targets lives in
// `src/net/webhook-target.ts`, which composes this file's address rules
// with the shape rules already in `src/keys/webhook-secret.ts`
// (`validateWebhookUrl`). Everything below is unchanged from the file it
// was copied from.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type OutboundRefusalReason =
  | "not_https"
  | "no_hostname"
  | "unresolvable"
  | "private_address"
  | "redirect_refused";

export class OutboundAddressRefusedError extends Error {
  constructor(
    readonly reason: OutboundRefusalReason,
    message: string,
  ) {
    super(message);
    this.name = "OutboundAddressRefusedError";
  }
}

/** Decimal-dotted IPv4 -> its 32-bit value. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = out * 256 + n;
  }
  return out;
}

/**
 * Every IPv4 range that must never be reached from a merchant-supplied
 * address. Written as [first, last] pairs computed from the CIDR rather
 * than as magic integers, so the intent is checkable by reading.
 */
const V4_BLOCKED: ReadonlyArray<readonly [string, number, string]> = [
  ["0.0.0.0", 8, "this host / unspecified"],
  ["10.0.0.0", 8, "private (RFC1918)"],
  ["100.64.0.0", 10, "carrier-grade NAT (RFC6598)"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local — includes the 169.254.169.254 cloud metadata endpoint"],
  ["172.16.0.0", 12, "private (RFC1918)"],
  ["192.0.0.0", 24, "IETF protocol assignments"],
  ["192.0.2.0", 24, "documentation (TEST-NET-1)"],
  ["192.168.0.0", 16, "private (RFC1918)"],
  ["198.18.0.0", 15, "benchmarking (RFC2544)"],
  ["198.51.100.0", 24, "documentation (TEST-NET-2)"],
  ["203.0.113.0", 24, "documentation (TEST-NET-3)"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"],
];

function describeBlockedV4(ip: string): string | null {
  const value = ipv4ToInt(ip);
  if (value === null) return null;
  for (const [base, bits, label] of V4_BLOCKED) {
    const baseInt = ipv4ToInt(base);
    if (baseInt === null) continue;
    // >>> 0 keeps the mask unsigned; a /0 would shift by 32, which is a
    // no-op in JS, so it is excluded by construction above (no /0 entry).
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((value & mask) >>> 0 === (baseInt & mask) >>> 0) return label;
  }
  return null;
}

function describeBlockedV6(ip: string): string | null {
  const lower = ip.toLowerCase();
  // An IPv4-mapped address is an IPv4 address wearing a v6 costume —
  // ::ffff:169.254.169.254 must be judged as 169.254.169.254, or the
  // whole v4 table above is bypassable by writing the same address
  // differently.
  //
  // ⚠️ TWO SPELLINGS, AND THE SECOND ONE IS THE ONE THAT ACTUALLY
  // ARRIVES. The first version of this function handled only the dotted
  // form and scripts/verify-outbound-address-guard.ts caught it RED:
  //
  //   MEASURED  new URL("https://[::ffff:169.254.169.254]/").hostname
  //             -> "[::ffff:a9fe:a9fe]"
  //
  // `new URL()` NORMALISES the mapped address into hex groups, so by the
  // time any of our code sees it the dotted form is gone. A guard that
  // only knew the dotted spelling would have let the cloud metadata
  // endpoint straight through while every other assertion in the file
  // stayed green — which is why the test asserts on the address a
  // browser and Node actually produce rather than the one a human types.
  const mappedDotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedDotted) return describeBlockedV4(mappedDotted[1] ?? "");
  // PORT(samapay): the `?? ""` exists only for `noUncheckedIndexedAccess`
  // (a successful match always has group 1). It is unreachable in the
  // real case and `describeBlockedV4("")` returns null, so no address is
  // judged differently.

  const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = parseInt(mappedHex[1] ?? "", 16);
    const low = parseInt(mappedHex[2] ?? "", 16);
    // PORT(samapay): the two `?? ""` as above — `parseInt("", 16)` is NaN,
    // which `ipv4ToInt` rejects, i.e. the same null answer.
    const dotted = [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join(".");
    return describeBlockedV4(dotted);
  }

  if (lower === "::" ) return "unspecified";
  if (lower === "::1") return "loopback";
  // fc00::/7 — unique local. First byte 0xfc or 0xfd.
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return "unique local (fc00::/7)";
  // fe80::/10 — link-local. First 10 bits 1111111010.
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return "link-local (fe80::/10)";
  if (lower.startsWith("2001:db8:")) return "documentation (2001:db8::/32)";
  if (/^ff[0-9a-f]{2}:/.test(lower)) return "multicast";
  return null;
}

function describeBlocked(ip: string): string | null {
  const family = isIP(ip);
  if (family === 4) return describeBlockedV4(ip);
  if (family === 6) return describeBlockedV6(ip);
  return null;
}

/** One DNS answer, in the shape this guard judges. */
export type ResolvedAddress = { readonly address: string };

/**
 * PORT(samapay): SEAM. How a hostname becomes addresses. The default is
 * the same call this file made before it was ported
 * (`node:dns/promises` `lookup(host, { all: true })`), and exists so the
 * suite can prove the refusals against a FIXED address table instead of
 * against whatever DNS this box can reach today — the failure mode
 * SamaPrime's own suite hit when its positive control used a real
 * vendor domain and went RED for a reason that had nothing to do with
 * the guard.
 */
export type AddressResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

async function defaultResolveAddresses(hostname: string): Promise<readonly ResolvedAddress[]> {
  return lookup(hostname, { all: true });
}

export interface OutboundGuardOptions {
  /**
   * Hostnames that skip the address check entirely.
   *
   * ⚠️ FOR OPERATOR-CONFIGURED DESTINATIONS ONLY — a self-hosted object
   * store on a private network is a legitimate config and an illegitimate
   * merchant input. NEVER populate this from anything a merchant, a
   * request body, a query param or a header can influence: an allowlist
   * an attacker can extend is not an allowlist.
   *
   * ⚠️ SAMAPAY: this is the ONLY sanctioned door for a loopback
   * destination, and in this service it is read from OPERATOR config,
   * never from anything a client submits. The caller passes it from the
   * env var `PANEL_WEBHOOK_ALLOWED_HOSTNAMES` — comma-separated, parsed
   * once in `src/panel/config.ts` (`readPanelConfig`, frozen) and threaded
   * through `src/http/routes/panel/index.ts` →
   * `panelSetWebhook({ allowedHostnames })` → `assertWebhookTargetUrl`.
   * Nothing in `src/net/` reads `process.env`, which is what keeps the
   * door out of a request body, a query param, a header or a `ClientKey`
   * row: if you are about to populate it from anything a client can
   * influence, stop — an allowlist an attacker can extend is not an
   * allowlist. The reason SamaPay needs the door at all is that MNTAD and
   * SamaShare share this box and talk over `http://127.0.0.1:3090`: a
   * webhook target on loopback is a normal deployment shape here — but it
   * is allowed by operator decision, per host, and refused by default.
   *
   * ⚠️ MATCHED AGAINST `url.hostname` VERBATIM, WHICH MEANS AN IPv6
   * LITERAL CARRIES ITS BRACKETS: the entry for `http://[::1]:3090/` is
   * `"[::1]"`, not `"::1"`, and `new URL()` may have rewritten an
   * IPv4-mapped address into hex groups before this compares
   * (`::ffff:127.0.0.1` arrives as `[::ffff:7f00:1]`). An allowlist entry
   * written in a spelling the parser never produces is a door that looks
   * open and is shut — write it in the spelling `url.hostname` shows.
   */
  readonly allowHostnames?: readonly string[];

  /** PORT(samapay): SEAM — see `AddressResolver`. Defaults to `node:dns`. */
  readonly resolveAddresses?: AddressResolver;
}

/**
 * Validate a URL for an outbound server-side request, or throw.
 *
 * Returns the parsed URL so a caller cannot accidentally validate one
 * string and fetch another — the checked value IS the value handed back.
 */
export async function assertOutboundUrlAllowed(rawUrl: string, options: OutboundGuardOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new OutboundAddressRefusedError("no_hostname", "That is not a valid URL.");
  }

  if (url.protocol !== "https:") {
    throw new OutboundAddressRefusedError(
      "not_https",
      "The address must start with https:// — an API token sent over http travels in clear text.",
    );
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostname) throw new OutboundAddressRefusedError("no_hostname", "That URL has no host.");

  if (options.allowHostnames?.includes(url.hostname)) return url;

  // A literal IP never reaches DNS, so it is judged directly. Without
  // this branch `https://169.254.169.254/` would fall through to a
  // lookup that returns it unchanged — correct by accident today, and
  // one refactor away from not being.
  if (isIP(hostname)) {
    const blocked = describeBlocked(hostname);
    if (blocked) {
      throw new OutboundAddressRefusedError("private_address", `That address is not reachable from here (${blocked}).`);
    }
    return url;
  }

  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await (options.resolveAddresses ?? defaultResolveAddresses)(hostname);
  } catch {
    throw new OutboundAddressRefusedError("unresolvable", "That host name does not resolve.");
  }
  if (addresses.length === 0) {
    throw new OutboundAddressRefusedError("unresolvable", "That host name does not resolve.");
  }

  // EVERY answer, not the first. A name that resolves to one public and
  // one private address is refused outright — which of them `fetch`
  // picks is not ours to decide, and "usually the public one" is not a
  // security property.
  for (const { address } of addresses) {
    const blocked = describeBlocked(address);
    if (blocked) {
      throw new OutboundAddressRefusedError("private_address", `That host resolves to an address that is not reachable from here (${blocked}).`);
    }
  }

  return url;
}

/** PORT(samapay): SEAM — the transport `guardedFetch` uses. */
export type FetchImpl = typeof fetch;

export interface GuardedFetchOptions extends OutboundGuardOptions {
  /**
   * PORT(samapay): SEAM. Defaults to the global `fetch`, i.e. exactly the
   * behaviour this file had before it was ported. Same reason the
   * dispatcher already has its own `fetchImpl`: a delivery (and so the
   * redirect refusal below) must be provable without making one.
   */
  readonly fetchImpl?: FetchImpl;
}

/**
 * `fetch`, with the address checked first and redirects refused.
 *
 * ⚠️ USE THIS RATHER THAN CALLING THE GUARD AND THEN `fetch` YOURSELF.
 * Two separate calls are two chances to validate one URL and request
 * another — the defect this repo has already paid for under the name
 * "a display rule and an action rule computed separately".
 */
export async function guardedFetch(rawUrl: string, init: RequestInit = {}, options: GuardedFetchOptions = {}): Promise<Response> {
  const url = await assertOutboundUrlAllowed(rawUrl, options);
  const response = await (options.fetchImpl ?? fetch)(url, { ...init, redirect: "manual" });

  // 3xx with `redirect: "manual"` arrives here rather than being
  // followed. Refused loudly: a redirect is how a validated host hands
  // the request to an unvalidated one.
  if (response.status >= 300 && response.status < 400) {
    throw new OutboundAddressRefusedError(
      "redirect_refused",
      "That address redirected somewhere else, which is not followed for provider connections.",
    );
  }
  return response;
}
