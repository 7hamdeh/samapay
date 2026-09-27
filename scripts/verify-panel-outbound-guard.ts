// COVERS: src/net/outbound-address-guard.ts src/net/webhook-target.ts
//
// =====================================================================
// *** A CLIENT MUST NOT BE ABLE TO AIM OUR WEBHOOK EGRESS AT OUR NETWORK. ***
// =====================================================================
// The panel (pay-dashboard-review.md, SSRF answer). A key's owner chooses
// `ClientKey.webhookUrl`; `src/webhooks/dispatch.ts` then POSTs our signed
// events to it, eight times over two days, from this box, and the delivery
// row reports back `status` / `last_status_code` / `last_error`. Point it at
// 127.0.0.1:5432 or 169.254.169.254 and that is a port scanner built out of
// our own egress. Same defect family as F2 of SamaPrime's
// docs/scratch/merchant-surface-security-review-2026-08-31.md — different
// input, different door.
//
// ⚠️ EVERY REFUSAL HERE IS PAIRED WITH A CONTROL THAT MUST BE ALLOWED.
// A guard that refuses everything satisfies every "is it blocked?"
// assertion ever written and would take webhooks down while looking like a
// security win. So each block below asserts a refusal AND that a legitimate
// public https target still passes, and the control runs FIRST and again
// LAST.
//
// ---------------------------------------------------------------------
// NO DATABASE, NO NETWORK. That is why there is no `assertSandboxDatabase()`
// as the first statement (against the repo's own rule, deliberately):
// nothing here touches a row, and the DNS the guard would otherwise do is
// replaced by the fixture resolver below, so this runs offline on any box —
// same shape as scripts/verify-webhook-signing.ts and
// scripts/verify-intent-state.ts. Run it with:
//   pnpm exec tsx scripts/verify-panel-outbound-guard.ts
//
// ⚠️ SCOPE, STATED HONESTLY: every DNS judgement below goes through the
// `resolveAddresses` seam, so this file proves the BLOCKLIST, the ORDERING
// and the CODES — not that `node:dns` is what runs behind the seam by
// default. SamaPrime's own scripts/verify-outbound-address-guard.ts covers
// the real-DNS path. It is not repeated here on purpose: that suite went
// RED once because its positive control pointed at a real vendor domain the
// box could not resolve, which read as a guard failure and was a fixture
// failure. A fixture answer cannot make that mistake twice.
import {
  assertOutboundUrlAllowed,
  guardedFetch,
  OutboundAddressRefusedError,
  type AddressResolver,
  type FetchImpl,
  type OutboundRefusalReason,
} from "@/net/outbound-address-guard.js";
import { assertWebhookTargetUrl, type WebhookTargetCode, type WebhookTargetResult } from "@/net/webhook-target.js";
import { check, summary } from "./lib/check.js";

// ── THE FIXTURE DNS ──────────────────────────────────────────────────
// A name missing from this table is a HARNESS bug and says so loudly; it is
// never quietly "unresolvable", which would look like a guard result.
const ANSWERS: Record<string, readonly string[]> = {
  "hooks.example.com": ["93.184.216.34"],
  "pay.mntad.com": ["188.114.96.1"],
  "two-public.example.com": ["93.184.216.34", "1.1.1.1"],
  "one-public-one-private.example.com": ["93.184.216.34", "10.0.0.5"],
  "metadata-by-name.example.com": ["169.254.169.254"],
  "mapped-dotted.example.com": ["::ffff:127.0.0.1"],
  "mapped-hex.example.com": ["::ffff:7f00:1"],
  "mapped-public.example.com": ["::ffff:93.184.216.34"],
  "internal-object-store.company": ["10.0.0.1"],
  "sub.internal-object-store.company": ["10.0.0.1"],
  "other.company": ["10.0.0.1"],
};
let dnsCalls = 0;
const resolveAddresses: AddressResolver = async (hostname) => {
  dnsCalls += 1;
  const answers = ANSWERS[hostname];
  if (!answers) throw new Error(`FIXTURE BUG: no DNS entry configured for "${hostname}"`);
  return answers.map((address) => ({ address }));
};
const resolveServfail: AddressResolver = async () => { throw new Error("fixture SERVFAIL"); };
const resolveNoAnswer: AddressResolver = async () => [];

const opts = (allowHostnames: readonly string[] = [], resolver: AddressResolver = resolveAddresses) => ({ allowHostnames, resolveAddresses: resolver });

async function guardReason(url: string, o = opts()): Promise<OutboundRefusalReason | null> {
  try { await assertOutboundUrlAllowed(url, o); return null; }
  catch (e) { if (e instanceof OutboundAddressRefusedError) return e.reason; throw e; }
}
async function targetResult(url: string, o = opts()): Promise<WebhookTargetResult> {
  return assertWebhookTargetUrl(url, o);
}
async function targetCode(url: string, o = opts()): Promise<WebhookTargetCode | null> {
  const r = await targetResult(url, o);
  return r.ok ? null : r.code;
}

// ── THE FIXTURE TRANSPORT ────────────────────────────────────────────
// Records what the guard actually asked for, so `redirect: "manual"` and
// "the network was never reached for a refused address" are MEASURED rather
// than assumed from reading the source.
type Sent = { readonly url: string; readonly init: RequestInit };
const sent: Sent[] = [];
let respondStatus = 200;
const fetchImpl: FetchImpl = async (input, init) => {
  sent.push({ url: String(input), init: init ?? {} });
  return new Response(null, { status: respondStatus });
};

/** `https://user:secretpw@hooks.example.com/private-path?token=TOPSECRET` */
const LEAKY = "https://user:secretpw@hooks.example.com/private-path?token=TOPSECRET";
function leaksInto(detail: string): string[] {
  return ["TOPSECRET", "secretpw", "private-path", "user:", "@hooks"].filter((needle) => detail.includes(needle));
}

async function main() {
  console.log("=".repeat(72));
  console.log("PANEL OUTBOUND GUARD — webhook target (SSRF)");
  console.log("=".repeat(72));

  // ── 1. *** THE CONTROL, FIRST *** ──────────────────────────────────
  // Deliberately before every refusal: a guard that refuses ALL input would
  // pass every assertion below and nothing above it would say so.
  console.log("\n1. *** THE CONTROL — A LEGITIMATE TARGET IS STILL ALLOWED ***");
  const controlUrl = "https://hooks.example.com/api/v2/samapay/webhook?delivery=1";
  check((await guardReason(controlUrl)) === null, "CONTROL: the guard allows a public https target with a path and a query");
  check((await targetResult(controlUrl)).ok === true, "CONTROL: webhook-target allows the same target");
  check((await targetCode("https://pay.mntad.com/api/samapay/webhook")) === null, "CONTROL: the real MNTAD receiver shape (public IP via the fixture) is allowed");
  check(dnsCalls > 0, "the fixture resolver WAS consulted — the check is on the RESOLVED address, not on the text of the host", `${dnsCalls} lookup(s)`);

  // ── 2. A PUBLIC LITERAL IP NEEDS NO DNS ────────────────────────────
  console.log("\n2. LITERAL PUBLIC ADDRESS — the direct branch, and its cost");
  const beforeLiteral = dnsCalls;
  check((await guardReason("https://93.184.216.34/")) === null, "a public literal IPv4 target is allowed");
  check(dnsCalls === beforeLiteral, "a literal IP never reaches DNS (the branch the ported file documents)", `dnsCalls ${beforeLiteral} -> ${dnsCalls}`);

  // ── 3. THE LOOPBACK DOOR IS OPERATOR CONFIG ────────────────────────
  // MNTAD and SamaShare share this box and talk over http://127.0.0.1:3090,
  // so loopback must be reachable — by NAME, from env config, never from
  // anything the key's owner typed.
  console.log("\n3. *** PLAIN HTTP TO LOOPBACK: ALLOWED ONLY BY THE OPERATOR'S ALLOWLIST ***");
  check((await targetCode("http://127.0.0.1:3090/webhooks/samapay", opts(["127.0.0.1"]))) === null, "http://127.0.0.1 allowed when the operator named it");
  check((await targetCode("http://localhost:3090/hook", opts(["localhost"]))) === null, "http://localhost allowed when the operator named it");
  check((await targetCode("http://[::1]:3090/hook", opts(["[::1]"]))) === null, 'http://[::1] allowed when the operator named it "[::1]" (brackets are part of url.hostname)');
  check((await targetCode("http://127.0.0.1:3090/hook")) === "loopback_not_allowlisted", "*** the same target with no operator allowlist is REFUSED (the fail-closed default) ***");
  check((await targetCode("http://[::1]:3090/hook", opts(["::1"]))) === "loopback_not_allowlisted", "an allowlist entry in a spelling url.hostname never produces does NOT open the door", 'entry "::1" vs hostname "[::1]"');
  check((await targetCode("http://169.254.169.254/latest/meta-data/", opts(["169.254.169.254"]))) === "not_https", "*** the operator door cannot rescue plain http to a NON-loopback host ***", "shape is judged before the door is consulted");
  check((await targetCode("http://other.company/", opts(["other.company"]))) === "not_https", "nor to an internal hostname over http");
  check((await guardReason("https://127.0.0.1:3090/")) === "private_address", "https to loopback is refused by default (the guard judges the literal)");
  check((await guardReason("https://127.0.0.1:3090/", opts(["127.0.0.1"]))) === null, "…and let through by the same operator door");
  check((await targetCode("https://127.0.0.1:3090/")) === "private_address", "webhook-target maps the guard's refusal onto a stable code");

  // ── 4. THE ADDRESS IS WHAT IS JUDGED, NOT THE NAME ─────────────────
  console.log("\n4. *** A NAME THAT RESOLVES SOMEWHERE PRIVATE ***");
  check((await guardReason("https://metadata-by-name.example.com/latest/meta-data/")) === "private_address", "*** a hostname resolving to 169.254.169.254 is refused ***", "every textual host check would have passed this");
  check((await targetCode("https://metadata-by-name.example.com/")) === "private_address", "…and webhook-target refuses it with the same code");
  check((await guardReason("https://one-public-one-private.example.com/")) === "private_address", "*** EVERY answer is judged: one public + one private is refused ***", "which one fetch picks is not ours to decide");
  check((await guardReason("https://two-public.example.com/")) === null, "CONTROL: two public answers are allowed");
  check((await guardReason("https://hooks.example.com/", opts(["hooks.example.com"], resolveServfail))) === null, "CONTROL: an allowlisted host skips the address check entirely (a SERVFAIL fixture never stops it)");

  // ── 5. THE v4 BLOCKLIST, RANGE BY RANGE, AT ITS BOUNDARIES ─────────
  // Each row is a PAIR of adjacent addresses: the one outside the CIDR must
  // be ALLOWED, the one inside refused. Membership in a long list is not
  // proof — only the boundary shows the MASK is right, and shows a guard
  // that refuses everything for the wrong reason.
  console.log("\n5. *** IPv4 RANGES AT THEIR BOUNDARIES (allowed | refused) ***");
  const V4_PAIRS: ReadonlyArray<readonly [string, string, string]> = [
    ["1.0.0.0", "0.0.0.0", "this host / 0.0.0.0/8"],
    ["9.255.255.255", "10.0.0.0", "RFC1918 10/8"],
    ["100.63.255.255", "100.64.0.0", "carrier-grade NAT 100.64/10"],
    ["100.128.0.0", "100.127.255.255", "the /10 ends at 100.127 (100.128 is public)"],
    ["126.255.255.255", "127.0.0.0", "loopback 127/8"],
    ["169.253.255.255", "169.254.0.0", "link-local 169.254/16"],
    ["169.255.0.0", "169.254.169.254", "the /16 ends at 169.254 (169.255 is public)"],
    ["172.15.255.255", "172.16.0.0", "RFC1918 172.16/12"],
    ["172.32.0.0", "172.31.255.255", "the /12 ends at 172.31 (172.32 is public)"],
    ["192.0.1.255", "192.0.2.0", "documentation TEST-NET-1 192.0.2/24"],
    ["192.0.1.255", "192.0.0.255", "IETF protocol assignments 192.0.0/24"],
    ["192.1.0.1", "192.168.0.0", "RFC1918 192.168/16"],
    ["198.17.255.255", "198.18.0.0", "benchmarking 198.18/15"],
    ["198.20.0.0", "198.19.255.255", "the /15 ends at 198.19 (198.20 is public)"],
    ["198.51.99.255", "198.51.100.0", "documentation TEST-NET-2"],
    ["203.0.112.255", "203.0.113.0", "documentation TEST-NET-3"],
    ["223.255.255.255", "224.0.0.0", "multicast 224/4"],
    ["223.255.255.255", "239.255.255.255", "multicast reaches 239"],
    ["223.255.255.255", "240.0.0.0", "reserved 240/4"],
  ];
  for (const [publicIp, blockedIp, label] of V4_PAIRS) {
    const allowed = await guardReason(`https://${publicIp}/`);
    const refused = await guardReason(`https://${blockedIp}/`);
    check(allowed === null && refused === "private_address", `${label}: ${publicIp} allowed, ${blockedIp} refused`, `${allowed ?? "allowed"} / ${refused}`);
  }
  for (const url of ["https://10.0.0.5:5432/", "https://192.168.1.1/", "https://172.16.4.4/", "https://100.64.0.1/", "https://169.254.169.254/latest/meta-data/"]) {
    check((await guardReason(url)) === "private_address", "refused outright (the addresses the review named)", url);
  }

  // ── 6. THE SAME MACHINE IN AN IPv6 COSTUME ─────────────────────────
  console.log("\n6. *** IPv6, AND IPv4-MAPPED IPv6 IN BOTH SPELLINGS ***");
  const V6_BLOCKED: ReadonlyArray<readonly [string, string]> = [
    ["[::1]", "loopback"], ["[::]", "unspecified"], ["[fc00::1]", "unique local fc00::/7"],
    ["[fd00::1]", "unique local fc00::/7"], ["[fe80::1]", "link-local fe80::/10"],
    ["[2001:db8::1]", "documentation 2001:db8::/32"], ["[ff02::1]", "multicast"],
  ];
  for (const [host, label] of V6_BLOCKED) {
    check((await guardReason(`https://${host}/`)) === "private_address", `refused: IPv6 ${label}`, host);
  }
  check((await guardReason("https://[2606:4700:4700::1111]/")) === null, "CONTROL: a public IPv6 literal is allowed");
  check((await guardReason("https://[::ffff:127.0.0.1]/")) === "private_address", "*** ::ffff:127.0.0.1 refused, whatever new URL() rewrote it into ***", "dotted on the way in");
  check((await guardReason("https://[::ffff:169.254.169.254]/")) === "private_address", "*** ::ffff:169.254.169.254 (the metadata endpoint) refused ***", "the exact case SamaPrime's suite caught RED");
  check((await guardReason("https://[::ffff:7f00:1]/")) === "private_address", "the HEX-GROUP spelling new URL() actually produces is refused", 'measured: new URL("https://[::ffff:127.0.0.1]/").hostname === "[::ffff:7f00:1]"');
  check((await guardReason("https://mapped-dotted.example.com/")) === "private_address", "a DNS answer of ::ffff:127.0.0.1 (dotted) is refused");
  check((await guardReason("https://mapped-hex.example.com/")) === "private_address", "a DNS answer of ::ffff:7f00:1 (hex) is refused");
  check((await guardReason("https://mapped-public.example.com/")) === null, "CONTROL: ::ffff:93.184.216.34 is unwrapped and ALLOWED — the v6 path is not a blanket refuse");

  // ── 7. SCHEME AND SHAPE ────────────────────────────────────────────
  console.log("\n7. SCHEME AND SHAPE");
  check((await targetCode("http://hooks.example.com/")) === "not_https", "plain http to a public host is refused", "a signed payload over http is a signed payload in clear text");
  check((await targetCode("file:///etc/passwd")) === "not_https", "file: is refused");
  check((await targetCode("gopher://x.example/")) === "not_https", "an exotic scheme is refused");
  check((await targetCode("not a url")) === "url_unparseable", "a non-URL is refused");
  check((await targetCode("https://")) === "url_unparseable", "a URL with no host is refused");
  check((await guardReason("https://")) === "no_hostname", "the guard's own reason for the same input", "no_hostname");

  // ── 8. CREDENTIALS IN THE URL ──────────────────────────────────────
  console.log("\n8. *** CREDENTIALS IN THE URL ***");
  check((await targetCode(LEAKY)) === "url_credentials", "https://user:pw@… refused");
  check((await targetCode("https://apitoken@hooks.example.com/hook")) === "url_credentials", "a username-only URL is refused too", "userinfo is a smuggling channel for a token");
  check((await targetCode("https://hooks.example.com/private-path?token=TOPSECRET")) === null, "CONTROL: the same target without credentials is allowed");
  check((await guardReason("https://user:pw@hooks.example.com/")) === null, "NOTED DIFFERENCE: the ported guard itself does not look at credentials — webhook-target is what refuses them", "kept verbatim from MNTAD on purpose");

  // ── 9. DNS THAT FAILS ─────────────────────────────────────────────
  console.log("\n9. DNS FAILURE IS A REFUSAL, NOT A PASS");
  check((await guardReason("https://hooks.example.com/", opts([], resolveServfail))) === "unresolvable", "a resolver that throws is refused");
  check((await guardReason("https://hooks.example.com/", opts([], resolveNoAnswer))) === "unresolvable", "a name with zero answers is refused");
  check((await targetCode("https://hooks.example.com/", opts([], resolveServfail))) === "unresolvable", "webhook-target reports the same code");

  // ── 10. REDIRECTS ARE REFUSED, NOT FOLLOWED ───────────────────────
  // ⚠️ The seam here is the TRANSPORT. A pre-flight check on the URL is
  // worthless if the fetch then hops to an unvalidated host; what closes it
  // is redirect:"manual" plus refusing the 3xx that arrives.
  console.log("\n10. *** REDIRECTS: REFUSED, NOT RE-CHECKED ***");
  const fetchOpts = { allowHostnames: ["hooks.example.com"], resolveAddresses, fetchImpl };
  for (const status of [301, 302, 303, 307, 308] as const) {
    respondStatus = status;
    let reason = "NO THROW";
    try { await guardedFetch("https://hooks.example.com/hook", { method: "POST", body: "{}" }, fetchOpts); }
    catch (e) { reason = e instanceof OutboundAddressRefusedError ? e.reason : `unexpected ${String(e)}`; }
    check(reason === "redirect_refused", `a ${status} answer is refused, not followed`, "a validated host must not hand our request to an unvalidated one");
  }
  respondStatus = 302;
  await guardedFetch("https://hooks.example.com/hook", { method: "POST", body: "{}" }, fetchOpts).catch(() => undefined);
  check(sent.at(-1)?.init.redirect === "manual", "*** the transport was asked with redirect: \"manual\" (measured on the call, not read off the source) ***", String(sent.at(-1)?.init.redirect));
  respondStatus = 200;
  const okResponse = await guardedFetch("https://hooks.example.com/hook", { method: "POST" }, fetchOpts).catch((e: unknown) => e);
  check(okResponse instanceof Response && okResponse.status === 200, "CONTROL: a 200 delivery goes through guardedFetch unmolested");
  respondStatus = 500;
  const errResponse = await guardedFetch("https://hooks.example.com/hook", { method: "POST" }, fetchOpts).catch((e: unknown) => e);
  check(errResponse instanceof Response && errResponse.status === 500, "CONTROL: a 500 is NOT a refusal — the check is on 3xx, not on unhappiness", "an endpoint that errors is still a legitimate target");
  respondStatus = 200;
  const sentBefore = sent.length;
  const dnsBefore = dnsCalls;
  let privateFetchReason = "NO THROW";
  try { await guardedFetch("https://metadata-by-name.example.com/latest/meta-data/", { method: "POST" }, { resolveAddresses, fetchImpl }); }
  catch (e) { privateFetchReason = e instanceof OutboundAddressRefusedError ? e.reason : `unexpected ${String(e)}`; }
  check(privateFetchReason === "private_address" && sent.length === sentBefore, "*** the transport is NEVER reached for a refused address (guard first, then fetch) ***", `transport calls ${sentBefore} -> ${sent.length}`);
  check(dnsCalls === dnsBefore + 1, "and it was refused by RESOLUTION, not by a textual match on the host", `${dnsCalls - dnsBefore} lookup(s)`);

  // ── 11. THE OPERATOR DOOR IS PER-HOST AND EXACT ────────────────────
  console.log("\n11. *** THE OPERATOR DOOR IS PER-HOST AND EXACT ***");
  let doorDnsCalls = 0;
  const counting: AddressResolver = async (hostname) => { doorDnsCalls += 1; return resolveAddresses(hostname); };
  check((await guardReason("https://internal-object-store.company/", opts(["internal-object-store.company"], counting))) === null, "an allowlisted private-network host is allowed (operator config, legitimate)");
  check(doorDnsCalls === 0, "*** and it skipped DNS entirely — \"skip the address check\" means skip it ***", `${doorDnsCalls} lookups`);
  check((await guardReason("https://other.company/", opts(["internal-object-store.company"]))) === "private_address", "CONTROL: a DIFFERENT host on the same allowlist is still refused", "an allowlist that matches by suffix is not an allowlist");
  check((await guardReason("https://sub.internal-object-store.company/", opts(["internal-object-store.company"]))) === "private_address", "CONTROL: a SUBDOMAIN of an allowlisted host is refused", "no substring matching");
  check((await targetCode("https://internal-object-store.company/", opts(["Internal.Object-Store.Company"]))) === "private_address", "an allowlist entry with capitals does NOT match (url.hostname is lowercased)", "write it in the spelling url.hostname shows");

  // ── 12. THE ANSWERS ECHO NOTHING BUT THE HOST ──────────────────────
  console.log("\n12. THE ANSWERS CARRY NO PATH, QUERY OR CREDENTIAL");
  const cred = await targetResult(LEAKY);
  const credDetail = cred.ok ? "" : cred.detail;
  check(leaksInto(credDetail).length === 0, "a credential refusal names the host and nothing else", credDetail);
  const unparse = await targetResult("https://exa mple.com/PATHWITHSECRET?token=XYZ");
  const unparseCode = unparse.ok ? "ok" : unparse.code;
  const unparseDetail = unparse.ok ? unparse.normalizedUrl : unparse.detail;
  check(unparseCode === "url_unparseable" && !unparseDetail.includes("PATHWITHSECRET") && !unparseDetail.includes("XYZ") && !unparseDetail.includes("://"), "a parse failure echoes NO part of what it was given", `${unparseCode} · ${unparseDetail}`);

  // ── 13. THE CONTROL, RE-RUN AFTER EVERY REFUSAL ────────────────────
  console.log("\n13. THE CONTROL, RE-RUN AFTER EVERY REFUSAL");
  const still = await targetResult(controlUrl);
  check(still.ok === true, "CONTROL: the ordinary public https target still passes", still.ok ? still.normalizedUrl : `${still.code} ${still.detail}`);
  check((await guardReason("https://hooks.example.com/")) === null, "CONTROL: the guard still allows it");

  console.log("\n" + "=".repeat(72));
  process.exit(summary());
}

main().catch((e) => {
  // Without this, a crash would report as a clean zero: process.exit() in a
  // `finally` runs before the exception propagates. A suite that cannot fail
  // loudly is the defect this repository is about.
  console.error("\n*** THE SUITE THREW — nothing after this point ran ***", e);
  process.exit(1);
});
