# SamaPay panel (pay.mntad.com) — SURVEY FIRST. 2026-09-06.

RAN BY value-model (session_01CCnfJkEiadQnznB17VT48H) against
/www/wwwroot/samapay at main 836c859 (clean; origin/main = 836c859) and
/www/wwwroot/samaprime.com at main 532a09d. Every ROUTE/SCOPE/DATA claim
below was read from the CODE, not the spec. RELAYED, marked as such: two
facts measured by the coordinator (pay.mntad.com → 000, no vhost; no
SamaPay production database) and Ibrahim's goal, quoted verbatim:

> "NEW GOAL — SAMAPAY PANEL: a client-facing site at pay.mntad.com where a
> site owner signs up, mints and revokes API keys, sees
> deposits/withdrawals per reference, reads docs, and gets a sandbox key.
> SEPARATE ACCOUNTS FROM SamaPrime. SURVEY FIRST (what the API already
> exposes, what the panel needs, auth reuse from the dahabi pattern:
> Google + email code), then a slice list. Design lead owns the look; a
> new lane builds it in its own worktree."

This document is the survey and the slice list. It contains no design.

---

## 0. THE FOUR THINGS TO READ IF YOU READ NOTHING ELSE

1. **"The dahabi pattern" does not live in the dahabi project.** MEASURED:
   `/www/wwwroot/dahabi.org` is an aaPanel placeholder (index.html
   "Congratulations, the site is created successfully!", no package.json,
   no code); `mailpanel.dahabi.org` is stock Roundcube 1.6.11 (PHP, IMAP
   password login, OAuth disabled, no emailed code). The Google + email-code
   login Ibrahim means is **SamaPrime's own** `auth.ts` + `lib/auth/otp.ts`
   (Auth.js v5, Google provider gated on `AUTH_GOOGLE_ID`, 6-digit bcrypt
   OTP, always-200 request endpoint). §3 measures what of it is reusable.
2. **"Separate accounts from SamaPrime" is a SECOND IDENTITY SYSTEM, not a
   shared one.** SamaPay's schema (`prisma/schema.prisma`) has Client,
   ClientKey, Address, Deposit, Withdrawal, Reservation, IdempotencyKey,
   WebhookDelivery, AuditEvent — and **no human**: no account, no session,
   no email, no password, no code table. Ibrahim ruled on 2026-09-04
   (model-correction §1) that v1 stores "whatever identifies the CLIENT",
   not an owner's email. The panel therefore adds human identity to SamaPay
   from zero: an `Account` (email, Google subject), an email-code table, a
   session, and an `Account ↔ Client` membership. None of SamaPrime's User
   rows, cookies or roles can be reused, by his own ruling.
3. **The key-minting mechanism already exists and has never run over HTTP.**
   `src/http/routes/admin-keys.ts` (POST /clients/:id/keys, DELETE
   /keys/:id, scope `keys.issue`) is written, unit-reachable, and
   DELIBERATELY NOT MOUNTED (`app.ts:3-5`); its own header says the panel is
   the caller it was kept for. `issue.ts` already refuses to mint
   `keys.issue` from anything but the CLI — the one refusal the panel needs
   most is already a mechanism.
4. **A "sandbox key" today is a live key with a different prefix.**
   `KeyEnvironment.test` is stored on the row and encoded in `sk_test_…`,
   and MEASURED across `src/**` nothing branches on it: `environment` is
   read only by `auth.ts:27` to be returned. A test key reaches the same
   chain adapters, the same allowance, the same sender. Handing one out as
   "sandbox" before that changes would be a lie with money behind it —
   §5 lists it as a refusal, §6 as a slice.

---

## 1. RECONCILIATION AGAINST THE PRIOR PLANS

Prior documents (all read in full): **A** samaprime `docs/scratch/samapay-api-v1-draft-2026-09-04.md`,
**B** samaprime `docs/scratch/samapay-boundary-measurement-2026-09-04.md`,
**C** samapay `docs/cut-window-2026-09-05.md`, **D** samapay
`docs/model-correction-2026-09-04.md`, **E** samapay `CLAUDE.md`,
**F** samapay `README.md`. Verdicts are against the CODE at 836c859.

| # | prior claim | where | verdict | measured |
|---|---|---|---|---|
| 1 | v1 has "no dashboard, no public signup"; "GET /balance and the audit table ARE the dashboard until someone needs a screen" | A:35-36, A:224 | **SUPERSEDED** by the new goal | a screen is now the goal; nothing in A forbids it, A scoped v1 |
| 2 | "Not a public gateway: keys issued by his hand or a SamaPrime admin action" | A:7, E:6-7 | **SUPERSEDED — and it is a RULE in E** | E is SamaPay's CLAUDE.md; a self-service panel contradicts its sentence 3. Changing E is a rule change = his keystroke. *Answered 2026-09-06, his hand:* "KEYS ARE MINTED BY THE OWNER'S HAND OR BY THE CLIENT PANEL'S OWN SIGNED-IN OWNER FOR THEIR OWN ACCOUNT — NEVER BY AN OPERATOR ON SOMEONE ELSE'S BEHALF." The old sentence is struck in E, not deleted. Note what moved: "a SamaPrime admin action" is GONE as a path, and a prohibition was ADDED |
| 3 | "External site owners (dahabi, others) will register on SamaPay's own site later with their own accounts and mint their own keys" | D:6-8 | **CONFIRMED as the goal** | the goal is this sentence made concrete |
| 4 | "Ignore my earlier 'store the owner's email so they find their keys later' — v1 stores whatever identifies the CLIENT" | D:8-10 | **CONFIRMED in code, and it is why §0.2 holds** | `Client` has id/name/kind/createdAt only; `samaprime_merchant_id` dropped |
| 5 | keep the admin-keys code, unmount the route; "the mechanism is what SamaPay's own registration site will need" | D:73 | **CONFIRMED** | `app.ts:3` comment + no `app.route` for it; handlers intact |
| 6 | Bearer `sk_live_…`, prefix lookup, argon2 verify, scopes on the row — copy SamaPrime's shape | A:94-105 | **CONFIRMED** | `auth.ts:22-32`, `generate.ts` |
| 7 | `environment: live/test` "because dahabi will want a test key before a live one" | A:106 | **CONFIRMED in schema, CONTRADICTED in behaviour** | no code path reads `environment` except to echo it (grep over src) |
| 8 | per-key `rps_limit` / `monthly_limit` | A:111-125 | **CONTRADICTED** — columns exist, nothing enforces them | grep `rpsLimit|monthlyLimit|429` over src → 0 |
| 9 | webhook secret "per client key, issued with the key" | A:195 | **CONTRADICTED — never written** | `webhookSecret` is READ by `dispatch.ts:27-29` and written NOWHERE in src/ or scripts/; every delivery hits `exhausted: "no webhook url/secret on key"` |
| 10 | `GET /balance?reference=` returns received/withdrawn, "NOT an allowance" | D:125-129 | **CONFIRMED, built** | `balance.ts:15-22`, `readByReference` |
| 11 | reference format `m:<merchantId>/u:<userId>` | D:138-145 | **SUPERSEDED by his 09-05 ruling** `client:tenant:kind:id` | `reference/index.ts:1-4`, enforced at `addresses.ts:27`, `withdrawals.ts:42` |
| 12 | Idempotency-Key required on writes, (key, idem) scope, 24h TTL, 90s stale lock | A:157-172 | **CONFIRMED** | `idempotency.ts` |
| 13 | audit is hash-chained append-only, with key.issued/key.revoked | A:233-241 | **CONFIRMED** | `AuditEvent`, `issue.ts:52,63` |
| 14 | "dahabi the second client", needs "NOT MEASURED beyond test key first" | A:256, E:5 | **still unmeasured — and dahabi has no code on this box** | §0.1 |
| 15 | `keys.issue` can only be minted from the CLI | issue.ts | **CONFIRMED** | `issue.ts:30-32` throws `keys_issue_not_via_admin` |
| 16 | SamaPay on pay.mntad.com: nginx vhost + PM2 — HIS LINE | C:156 | **CONFIRMED open** | RELAYED: 000, no vhost. MEASURED by me: `getent hosts pay.mntad.com` → nothing (no DNS record either); `mntad.com` resolves to Cloudflare and is a placeholder vhost; `stores.mntad.com` exists |
| 17 | SamaPay production DB — HIS LINE | C:155 | **CONFIRMED open** | RELAYED; `.env.sandbox` exists, no production `.env` |
| 18 | chain layer is a refusing stub until step 4 | registry.ts | **CONFIRMED** | every adapter throws `ChainUnavailable`; `POST /addresses` answers 503 today |
| 19 | B: 43 non-crypto rows must be re-encrypted before the cut; C: "the env var stays in both services; only the seed moves" | B:73-80 vs C:118-122 | **contradiction between prior docs, OUT OF SCOPE for the panel** | noted so nobody reads B as current; C is the later ruling |

**What the reconciliation changes about the work:** rows 7, 8, 9 are three
places where the spec says a thing exists and the code does not enforce it.
A panel that displays "sandbox key", "rate limit 10 rps" or "webhook
configured" from the schema would be showing three lies. Each is a slice
(§6), not a UI field.

---

## 2. THE MEASURED API SURFACE (what a key can and cannot do TODAY)

Stack: Hono 4.6 over Web Request/Response, Prisma 6.19.3, zod 4, argon2
via `@node-rs/argon2`, pino. Binds `127.0.0.1:3090` (`server.ts:10-11`).
Health: `GET /health` → `{ok, service:"samapay", version:"0.1.0"}`.

Auth on every route: `Authorization: Bearer sk_(live|test)_<40 base32>`;
prefix = first 12 chars, unique lookup; full key argon2-verified; unknown /
wrong / revoked all answer the SAME `401 unauthorized "Invalid API key."`
(`auth.ts:29-32`). `last_used_at/ip` written fire-and-forget on every call.

| route | scope | idempotent | does | refuses |
|---|---|---|---|---|
| `POST /addresses {chain, reference}` | addresses.write | yes (header required) | derives ONE address bound to (key, reference, chain) for life; same triple → same address, `reused:true` | malformed reference (`invalid_input`, shape `client:tenant:kind:id`); chain not wired → **503 chain_unavailable (today, always)** |
| `GET /deposits?since&reference&status` | deposits.read | — | up to 500 rows under THIS key, with `counts_toward_allowance = status==="confirmed"` | bad `since`/`status` |
| `POST /withdrawals {to, amount, chain, reference?}` | withdrawals.write | yes | reserves under a per-key advisory lock, audits, hands to the sender; 202 with the UNCLAMPED position | `409 allowance_exceeded {received, withdrawn, requested}`; malformed reference; amount not `^\d+(\.\d{1,6})?$` |
| `GET /withdrawals/:id` | withdrawals.read | — | one row, under THIS key only | `404` if another key's |
| `GET /balance` | balance.read | — | `{received, withdrawn, allowance, deposit_count, withdrawal_count}` — five numbers, never clamped | — |
| `GET /balance?reference=x` | balance.read | — | `{received, withdrawn, counts}` for one reference, explicitly "reconciliation only" | — |
| `POST /clients/:clientId/keys`, `DELETE /keys/:keyId` | keys.issue | no | issue (plaintext once) / revoke (audited) | **NOT MOUNTED**; and `keys.issue` itself cannot be minted here |

**Invariants the panel inherits and must not paper over:**
- The allowance is PER KEY (D:81-83). A key can withdraw at most what
  arrived at addresses issued to that key. `reference` is an index, never a
  bound. A panel "per reference" view is reconciliation, and must say so.
- The plaintext key exists once, in the issuing response. Nothing stores
  it; `keyLast4` + `keyPrefix` are the only display handles.
- Revocation is `active=false, revokedAt` — the key's addresses, deposits
  and allowance stay attached to the DEAD key. `successorKeyId` exists as a
  column and no code writes it: **there is no rotation.** Revoking the only
  key of a client strands its money behind a key that can no longer call
  `POST /withdrawals`. That is a §5 refusal.
- Deposits have one writer (`src/observer/`), asserted by a control.
- Every mutation is one hash-chained audit row with `actor`.

**What is NOT in the API and the panel must not invent:** list-keys,
list-clients, key rotation, webhook-URL update, webhook-secret issuance
(never written anywhere — row 9), rate limiting (row 8), any `environment`
behaviour (row 7), any per-account or per-human concept, docs.

**Test coverage a panel can lean on:** `scripts/verify-auth-and-keys.ts`
drives the real Hono app in-process (`app.request`) for auth and scopes;
`verify-routes-end-to-end.ts`, `verify-reference-format.ts`,
`verify-webhook-signing.ts`, five `verify-allowance-*` suites. All are
sandbox-guarded (`assertSandboxDatabase()` first).

---

## 3. AUTH — WHAT "THE DAHABI PATTERN" IS, AND WHAT IT COSTS TO REUSE

### 3.1 Where it is (MEASURED, files opened)
- Not in `/www/wwwroot/dahabi.org` (placeholder), not in
  `mailpanel.dahabi.org` (Roundcube, IMAP login), not in `mail.dahabi.org`
  (proxy shell). **It is `/www/wwwroot/samaprime.com/auth.ts`.**
- Stack there: Next.js 15.5.22, `next-auth 5.0.0-beta.32`, JWT sessions,
  NO database adapter (`auth.ts:56-59` says so), Prisma 6.19.3, `bcryptjs`,
  `nodemailer`, `zod`, `next-intl`.
- Google: `next-auth/providers/google`, registered only when
  `AUTH_GOOGLE_ID` + `AUTH_GOOGLE_SECRET` are present (`auth.ts:67-69`);
  both ARE present in production `.env` (key names only), as are Facebook
  and Apple pairs. Verified-email read from the OIDC claim (`auth.ts:97`).
- Email code: `lib/auth/otp.ts` — CSPRNG 6 digits, bcrypt cost 10, 10-min
  TTL, previous unused codes invalidated on each request, request limit 5
  per 15 min per (email, ip) DB-backed, verify limit 5 per 15 min
  IN-MEMORY (resets on restart), Arabic-digit normalisation, request
  endpoint ALWAYS 200 (even on a Zod failure), verify endpoint 400/401/200.
- Session: Auth.js JWT cookie with a cross-subdomain `domain=.samaprime.com`
  override; `token.id`, `token.role`, optional `impersonating`.
- Guards: `requireUser()` redirects (pages); `requireConsumer/…` throw
  (actions); roles CONSUMER/DISTRIBUTOR/MERCHANT/ADMIN checked against the
  live row for elevated roles.

### 3.2 What is coupled to SamaPrime (would be REWRITTEN, not copied)
Every auth file imports SamaPrime-only things: `lib/db/client` (SamaPrime's
schema), `lib/user/slug` + `referral-code` (NOT NULL unique columns on
`User`), `lib/referral/capture` (the `salam_ref` cookie + referral engine),
`lib/settings` (`site.registration_enabled` from the settings table),
`lib/email/send-otp` + `lib/config/brand` (branded template), `lib/auth/rbac`
(four roles), `lib/db/platform-merchant` (a Merchant row), `lib/subdomain`,
`lib/auth/provider-link-token`. Prisma models touched: User, OTPToken,
LinkedProvider, Wallet, Merchant, Distributor.

### 3.3 What is generic (portable as-is)
`next-auth` + Google/Credentials providers, `bcryptjs`, `node:crypto`,
`nodemailer`, `zod`; two helpers with no schema dependency:
`lib/auth/otp-digits.ts` (Arabic-Indic normalisation) and
`lib/auth/safe-redirect.ts`. The DESIGN of otp.ts (always-200 request,
same-error-for-throttle-and-wrong-code, invalidate-previous, bcrypt at
rest, CSPRNG) is the reusable part — as a specification, re-implemented
against SamaPay's own tables.

### 3.4 What SEPARATE ACCOUNTS actually costs (plain)
SamaPay must gain, from zero: an `Account` table (email, optional Google
subject id, created/last-login), an `EmailCode` table (hash, expiry,
consumed, ip — the OTPToken shape), a `Session` (cookie → account; JWT or
DB-backed, the lane's call with security review), an `AccountClient`
membership (which humans own which Client, with a role at least
owner/viewer), and an `AuditEvent` actor form for humans
(`account:<id>`). That is one migration on a database that does not yet
exist in production, so it is EXPAND-only and rides with the first
production migration — his keystroke (C:155). Nothing from SamaPrime's
user table, cookie or roles crosses over: the cookie domain is
`.samaprime.com`, the panel is on `mntad.com`, and his ruling says no
link. Two consequences to say out loud: (a) Ibrahim himself will have a
SamaPay account distinct from his SamaPrime admin; (b) SamaPrime, as a
client, is represented in the panel only if someone creates an Account
and links it to the platform Client — the panel must not do that
automatically.

### 3.5 Two SamaPrime findings from reading its auth (NOT the panel's, relayed for the money reviewers)
- **MEASURED by me at `lib/auth/social.ts:239-243`:** Google/Facebook
  sign-up still `wallet.upsert`s a USDT wallet against the PLATFORM
  merchant, while `otp.ts:271-286` says signup no longer creates a wallet
  (slice 1, 2026-08-31) because signup cannot know the merchant. The comment
  at `social.ts:219-223` claims the two paths mirror each other; they have
  drifted, in the money direction. Not touched here.
- Agent-measured, file:line cited, not re-verified by me: `otp.ts:135`
  calls `sendOtpEmail(email, code)` with no locale, so every OTP mail is
  English; and Apple registers in production despite `auth.ts:51-53`
  saying it stays unregistered.

---

## 4. WHAT THE PANEL NEEDS (from his sentence, mapped to what exists)

| his words | exists in SamaPay? | gap |
|---|---|---|
| a site owner signs up | NO — no human model | §3.4 identity system; Google + email code re-implemented |
| mints API keys | mechanism YES (`issueKey`, unmounted route) | mount behind ACCOUNT auth, not bearer auth; scope choice UI; plaintext shown once |
| revokes API keys | YES (`revokeKey`) | refusals in §5 |
| sees deposits per reference | YES (`GET /deposits?reference=`, `GET /balance?reference=`) | panel reads with the ACCOUNT's session, not a client key — needs an internal read path scoped by AccountClient, or the panel calls the API with a server-held key (rejected: that key would be a privileged path) |
| sees withdrawals per reference | PARTIAL — only `GET /withdrawals/:id` by id; no list, and `reference` is nullable on withdrawals | a list read is new |
| reads docs | NO | static; the route table in §2 is the seed |
| gets a sandbox key | NO — see §0.4 | `environment=test` must MEAN something first |
| separate accounts | by construction | §3.4 |

---

## 5. WHAT THE PANEL MUST REFUSE — a client's mistakes are a stranger's money

Written before the offers because the offers are easy.

1. **Never reveal a plaintext key twice.** Only the issuing response
   carries it (`issue.ts:2-3`). No "show key" button, ever; only prefix +
   last4.
2. **Never mint `keys.issue` from the panel.** Already impossible
   (`issue.ts:30-32`); the panel's scope picker must not even list it, and
   a red-first test must prove the API refuses it via the mounted route.
3. **Refuse to revoke a key while it has value or motion behind it** —
   allowance > 0, or any withdrawal in the consuming set (pending/sending/
   sent/confirmed…/send_unknown/failed) — until rotation exists
   (`successorKeyId` is written by nothing). Otherwise a click strands
   money behind a dead key with no API path back. Until then: revoke only
   at allowance 0 and no open withdrawals, with the numbers shown.
4. **Refuse to hand out a "sandbox" key until `environment=test` is
   enforced** at the chain layer (testnet adapters or a mock observer) and
   at the allowance (a test key's money never mixes with live). Today a
   test key is a live key.
5. **Refuse cross-client reads by construction.** Every panel read must be
   scoped through `AccountClient → Client → ClientKey`, never by a keyId
   from the URL alone; a red-first test with two accounts and two clients,
   asserting the wrong one gets 404 (not 403 — do not confirm existence).
6. **Refuse to let the panel hold a privileged API key.** The panel talks
   to SamaPay's data as the account, through its own guarded read layer or
   an account-authenticated internal route — never by embedding a bearer
   key with `keys.issue` in a web server. "No privileged path" is the
   founding sentence of this service.
7. **Refuse per-reference reads that can prefix-leak.** Any "all references
   of my tenant" aggregation must use `tenantPrefix()` with its trailing
   colon (`reference/index.ts:94-105`), never a bare `startsWith`.
8. **Refuse to label a per-reference figure as a balance.** It is
   reconciliation; the allowance is per key. The word "allowance" appears
   only on the per-key view (D:81-83).
9. **Refuse account enumeration.** Sign-up/email-code request is always
   200; throttled and wrong-code are the same answer; Google sign-in with an
   unverified email is refused (the SamaPrime pattern, kept).
10. **Refuse deletion.** No "delete client", no "delete account" in v1:
    every money row is `onDelete: Restrict` and the audit chain is
    append-only. Deactivate, never delete.
11. **Refuse webhook configuration that cannot be signed.** Setting a
    `webhookUrl` without issuing a `webhookSecret` (shown once, like the
    key) produces deliveries that exhaust silently (row 9). The panel must
    issue both together or neither.
12. **Refuse to show a rate limit the API does not enforce** (row 8).
13. **Refuse any path that mints for an account other than the signed-in
    one** — his rule, 2026-09-06: "NEVER BY AN OPERATOR ON SOMEONE ELSE'S
    BEHALF." Not a UI absence: the minting function takes the acting
    Account from the SESSION and the target Client from an AccountClient
    membership of THAT account, never from a request parameter; there is no
    operator/admin role in the panel that can widen it; and a red-first
    assertion mints as account A against a client owned only by account B
    and asserts the refusal names this rule (`not_your_account`), not a
    generic 403. Refusals 2 and 6 are now underwritten by the same rule
    rather than merely prudent. `issuedBy` becomes `account:<id>` and
    `issuedVia` gains `panel_owner`; the value `samaprime_admin_action`
    describes a path that no longer exists and must not be written again.
    *His confirmation, unprompted, 2026-09-06, verbatim:* "Yes — THE
    SUPPORT-PATH BAN IS DELIBERATE. Staff help a client mint their own key;
    STAFF NEVER MINT IT FOR THEM. 'From help' is exactly the door that
    opens later." That sentence is the operational test for any future
    support flow: guidance, a link, a walkthrough — yes; the mint itself —
    never.

**On `issue.ts:30-32` under the new rule.** It refuses to mint the
`keys.issue` scope from anything but the CLI. That stays CORRECT and is
strengthened, not widened: `keys.issue` is the operator scope (issue and
revoke keys for ANY client), which is exactly the "operator on someone
else's behalf" the rule forbids. The panel mints only client-money scopes
(addresses.write, deposits.read, withdrawals.*, balance.read) for the
signed-in owner's own client; it never needs `keys.issue`, so the CLI
remains the only legitimate source of that scope, and the unmounted
`admin-keys.ts` route — which mints for `:clientId` from the URL under a
bearer key — is the wrong shape for the panel and must NOT be mounted as
is: its target comes from the path, not from the caller's own account.
S4 writes an account-authenticated sibling instead and leaves
`admin-keys.ts` unmounted (or deletes it, with the reason). **Said
plainly so nobody later finds an unmounted route that looks ready and
helpfully wires it up: MOUNTING `admin-keys.ts` AS IT STANDS WOULD VIOLATE
THE 2026-09-06 RULE** — it is the "looks finished because the thing that
would expose it is disabled" shape this repository has paid for.

---

## 5b. THE ARCHITECTURE NOTE OF 2026-09-06 — RECONCILED AGAINST THIS DOCUMENT

Ibrahim, verbatim (relayed by the coordinator):

> "SamaPay architecture note: IT IS A PAYMENT GATEWAY WITH CHANNELS, NOT A
> USDT WALLET ALONE. Channels = adapters: usdt (bsc/tron, ours), shamcash
> (via 4reply for now), syriatel_cash, mtn_cash, bank. ONE CLIENT API:
> create intent, verify by reference, webhook on confirm, allowance per
> key. The dahabi Sham Cash verifier being built now must be shaped so it
> moves into SamaPay as its first non-crypto channel — same interface, no
> rewrite."

Everything above §5b was written against "a crypto service with a panel
on top". MEASURED at 836c859: zero files in `src/` name channel, shamcash,
syriatel, mtn or 4reply (control: `chain` hits 15 files). The only adapter
abstraction is `ChainAdapters { deriver, observer, sender, prover }`
(`src/chain/types.ts`), four refusing stubs. "Channel" is a new
abstraction with one intended shape and no implementation.

### 5b.1 His four verbs against the routes that exist

| verb | exists? | what the code has | what is missing |
|---|---|---|---|
| **create intent** | **NO** | the nearest thing is `POST /addresses {chain, reference}` — a standing expectation of inbound money, bound to a reference, with no amount, no expiry, no id, no status | an `Intent` (id, key, channel, reference, expected amount + currency, expiry, status, channel-specific instructions such as an address or a payee number + memo). For crypto the address IS the instruction; for Sham Cash the instruction is "pay N SYP to account X, write reference R" |
| **verify by reference** | **PARTIAL, passive only** | `GET /balance?reference=` and `GET /deposits?reference=` READ what the observer already recorded | an active verb: for a channel with no chain, "verify" is SamaPay asking the channel's verifier (4reply today) whether a payment matching (reference, amount) exists — a call that WRITES a confirmed payment. Crypto verifies passively (observer); Sham Cash verifies on demand |
| **webhook on confirm** | **YES, and broken** | `deposit.confirmed` enqueued by the observer, signed, retried | the secret is never written (§1 row 9), so nothing is ever delivered; event names must generalise (`payment.confirmed`, carrying `channel`) |
| **allowance per key** | **YES** | `read.ts`: SUM(deposit.amount WHERE confirmed) − SUM(withdrawal.amount WHERE consuming), per key | it sums `amount` with NO CURRENCY. See 5b.3 — this is the one that breaks first |

### 5b.2 What a channel is, as an interface — the crypto shape does NOT generalise as-is

`ChainAdapters` is `deriveNext(chain) → address`, `scan(addresses) →
transfers`, `confirmationsFor(txHash)`, `send(chain, to, amount)`,
`exists(txHash)`. Two of the five have no Sham Cash meaning: there is
nothing to DERIVE (the payee account is fixed, the intent is
distinguished by the memo/reference, not by a fresh address) and nothing
to SEND in the same sense (a cash-out is an agent action, not a broadcast).
So the honest answer to "same interface, no rewrite" is: **not the chain
interface.** The interface that does generalise sits one level up, at the
INTENT, and crypto becomes one implementation of it:

```
interface Channel {
  id: "usdt_bsc" | "usdt_tron" | "shamcash" | "syriatel_cash" | "mtn_cash" | "bank" | "sandbox"
  currency: "USDT" | "SYP" | …                 // ONE currency per channel
  capabilities: { collect: true; payout: boolean; passiveObserve: boolean }

  // create intent → the instructions a payer follows
  prepare(intent: { keyId; reference; amount?; expiresAt? }): Promise<Instructions>
       // crypto:   { address }               (deriveNext under the hood)
       // shamcash: { payee, memo: reference } (no derivation)

  // verify by reference → zero or more confirmed payments for this intent
  verify(intent): Promise<Confirmation[]>       // active: shamcash asks 4reply
  observe?(intents): Promise<Confirmation[]>    // passive: crypto scans
  finality(confirmation): Promise<{ final: boolean; detail }>  // confirmations, or a reversal window

  // payout, where the channel has one
  payout?(to, amount): Promise<PayoutResult>    // crypto: send; shamcash: unsupported in v1
  proveAbsence?(ref): Promise<Evidence>         // for refunds; crypto: TxExistenceProver
}
```

What must be TRUE of `Confirmation` for the one rule to survive: it
carries `channel`, `externalRef` (tx hash, 4reply receipt id, bank
statement line — the field that is UNIQUE per channel and makes "one
credit per event" structural, today `@@unique([chain, txHash])`),
`amount`, `currency`, `reference`, `evidence` (what the verifier saw —
for a chain it is the chain; for Sham Cash it is a screenshot or an SMS
parse, and the panel must say which). The invariant "the only writer of
`deposits` is `src/observer/`" becomes "the only writer of payments is a
CHANNEL's verify/observe, through one recording function" — still one
door, now with a `channel` column on the row.

The seams that make the dahabi verifier a move rather than a rewrite are
therefore: it takes `(reference, expectedAmount)` and returns
`Confirmation[]` with a channel-unique `externalRef` and its evidence;
it never decides what the reference MEANS (shape only, `client:tenant:
kind:id`); it reports distinguishable outcomes (`confirmed` / `not_found`
/ `amount_mismatch` / `verifier_unavailable`) rather than a boolean — a
`false` that means "4reply was down" is the "absent vs incapable" defect
this repository names most; and 4reply is ONE implementation behind
`shamcash`, replaceable, not the channel itself.

### 5b.3 Allowance for a non-crypto channel — the rule generalises, the SUM does not

The rule "a key may take out at most what came in under it" generalises:
"came in" means confirmed payments recorded by a channel's verifier for
this key, and "took out" means payouts on a channel that has them.
`read.ts` already sums ROWS, not chain reads, so a Sham Cash confirmation
written as a payment row would count — **and that is the defect**: it
sums `amount` across rows with no currency. One 100,000 SYP payment and
one 100 USDT payment would read as 100,100 of something. MEASURED:
`Deposit.amount` is `Decimal(18,6)` with no currency column;
`Withdrawal.amount` likewise; `read.ts:15-16` aggregates both with no
channel or currency predicate.

So allowance must become **per (key, currency)** — or per (key, channel),
which is stricter and is the safer default while no channel can pay out
into another: a Sham Cash inflow does not make USDT withdrawable, and the
day it should (FX inside SamaPay) is a money decision for him, not a
default. `GET /balance` grows a `currency`/`channel` axis and the panel
shows one position per channel; "allowance" stays per key WITHIN a
channel. Trust also changes shape: a chain confirmation is evidence the
service verified itself; a Sham Cash confirmation is evidence a verifier
(4reply) asserted — the panel labels the evidence class, and a payout
against verifier-asserted inflow is a decision he has not made.

### 5b.4 What the panel must show per channel (reshapes S5)

"Deposits" stops being one list. Per client: channels enabled; per
channel: currency, position (received / withdrawn / allowance), payments
(with `channel`, `externalRef`, evidence class, finality), intents
(open/expired/paid), payouts where supported. Per reference: the same
across channels, grouped by channel, never summed across currencies.

### 5b.5 Reconciliation of my own ten slices against the note

| slice | verdict | why |
|---|---|---|
| S0 stack | unchanged | independent of channels |
| S1 identity | unchanged | humans are channel-agnostic |
| S2 email code, S3 Google | unchanged | |
| S4 keys | unchanged in shape; SCOPES grow | `intents.write`, `payments.read` replace/extend `addresses.write`, `deposits.read`; per-channel scoping is a decision (a key limited to shamcash?) — his call, default: scopes are verbs, channels are enabled per client |
| S5 reads | **RESHAPED** | per channel, per currency; "payments" not "deposits"; intents appear (5b.4) |
| S6 webhooks | unchanged mechanism; events renamed | `payment.confirmed` with `channel`; the secret must still be written (row 9) |
| S7 sandbox | **RESHAPED, and simpler** | a sandbox is now a CHANNEL (`sandbox`, currency `TEST`, `verify()` confirms on request) — no fake chain needed; `environment=test` keys see only that channel |
| S8 docs | regenerated from the new route table | |
| S9 rate limits | unchanged | |
| S10 rotation | unchanged | keys, not channels |
| **written against "a crypto service" and now WRONG** | §2's "what a key can do" table and §4's mapping — they describe the current routes truthfully but as the product, not as one channel | superseded by 5b.1; kept as the measured baseline |

New slices, before S5 and S7 in dependency order:
- **C0 — `Channel` interface + registry**, with the crypto adapters
  wrapped as `usdt_bsc`/`usdt_tron` (no behaviour change; the refusing
  stubs stay refusing) and a `sandbox` channel as the first REAL
  implementation — which is also the test double every later suite uses.
  **The `externalRef` a channel returns is a PROMISE; the guarantee is an
  INDEX.** Today one-credit-per-event is structural only because of
  `@@unique([chain, txHash])` — chain-shaped. A Sham Cash confirmation has
  no chain and no txHash, so a non-crypto channel arrives with NO
  structural protection against crediting one payment twice (a retry, a
  duplicate webhook, an operator refreshing a page). That is the larger of
  the two defects in 5b.3: the currency one reads a wrong number; this one
  credits real money twice. Same rule SamaPrime earned as ONE CREDIT PER
  REFERENCE — the code's lock is what fails, the index is what holds.
- **C1 — `Intent` model + `POST /intents`, `GET /intents/:id`**; `POST
  /addresses` becomes the crypto channel's `prepare()` behind it (kept
  mounted for SamaPrime until the cut is done).
- **C2 — currency + channel on payment and payout rows; allowance per
  (key, channel); AND `@@unique([channel, externalRef])` on payments**,
  replacing `@@unique([chain, txHash])` (crypto's externalRef IS the
  txHash, so nothing is lost). Two red-first assertions, each naming the
  mechanism that refused: a SYP confirmation must not move the USDT
  allowance; and `verify()` called TWICE for one Sham Cash payment must
  write ONE row. **Two layers, two DISTINCT outcomes, on purpose:** the
  application pre-check (`SELECT` before insert) refuses with
  `already_recorded`; the index refuses with a DIFFERENT code,
  `duplicate_event`, carrying the constraint name (`payments_channel_
  external_ref_key`) from the driver error in its detail. P2002 is NOT
  mapped onto `already_recorded` — the coordinator's catch, 2026-09-06: if
  both layers produce one observable, deleting the pre-check leaves the
  suite green for the other reason and the mutation cannot say which
  layer held (the voucher-path incident in SamaPrime's CLAUDE.md, where 25
  assertions survived a deleted guard until the losers were made to throw
  a distinguishable error). So the mutation is decisive: delete the
  pre-check → the sequential test goes RED naming `duplicate_event`;
  restore it → `already_recorded`. And a CONCURRENT test (two `verify()`
  calls racing) must see exactly one row and, for the loser, `duplicate_
  event` — because under a race the pre-check LOSES (both callers pass it)
  and only the index holds. Neither layer is dropped: the pre-check gives
  ordinary retries a clean error without a failed transaction; the index is
  the guarantee. Defence in depth makes the mutation more necessary, not
  less — either layer can rot invisibly while the other carries the
  outcome. C3 must not land before C2 does, or its double-credit
  protection is caller discipline.
  This is a migration on a database that does not exist in production yet
  — EXPAND, rides with the first production migration.
- **C3 — `shamcash` channel = the dahabi verifier moved behind C0's
  interface**, with `verify()` returning distinguishable outcomes and
  4reply as its implementation; `payout: false` in v1.
- syriatel_cash, mtn_cash, bank: named, not surveyed; nothing exists.

## 6. SLICE LIST (thin, vertical, each red-first; ordered so each is the first real consumer of the last)

Preconditions that are HIS keystrokes and gate the LIVE half only
(sandbox work proceeds now): SamaPay production DB + first migration;
nginx vhost + PM2 for pay.mntad.com (and a DNS record — none exists);
the rule-change in SamaPay's CLAUDE.md sentence 3 ("Not a public
gateway…") — see §7.

- **S0 — Stack decision + skeleton (no UI).** A second process
  (`samapay-panel`) or routes inside the Hono app? Recommendation, stated
  so it can be refused: a separate Next.js app in `/www/wwwroot/samapay`'s
  repo under `panel/` is the natural home for Google via Auth.js and for
  design-lead's work, talking to SamaPay's Postgres through the same
  Prisma schema — but it must not import `src/http` bearer auth. The
  alternative (Hono + server-rendered pages) keeps one process and one
  deploy. Decide once; write it in `docs/`.
- **S1 — Identity migration (EXPAND only).** `Account`, `EmailCode`,
  `Session`, `AccountClient`; audit actor `account:<id>`. Sandbox-applied,
  file-to-file generated, red-first structural suite. Production apply is
  his line and rides with the first production migration.
- **S2 — Email-code login** re-implemented to the otp.ts specification
  (§3.3) against S1's tables; always-200 request; suite proves throttle ==
  wrong-code; Arabic-digit normalisation reused.
- **S3 — Google sign-in** via Auth.js Google provider, verified-email only;
  refusal 9. Needs `AUTH_GOOGLE_ID/SECRET` for the panel's own OAuth client
  (a new Google Cloud credential for pay.mntad.com — his keystroke in the
  Google console).
- **S4 — Client + key lifecycle behind ACCOUNT auth.** Reuse `issueKey`/
  `revokeKey` behind NEW account-authenticated routes whose target client
  is resolved from the session's AccountClient membership (never from the
  URL); do not mount `admin-keys.ts` (see §5, refusal 13); scope picker
  excludes `keys.issue`; plaintext once; refusals 1, 2, 3, 5, 6, 10, 13
  each with a red-first assertion that names the refusal (`assert which
  mechanism refused`).
- **S5 — Reads: keys list, per-key position, deposits and withdrawals per
  reference, prefix aggregation.** Needs a new `GET /withdrawals` list in
  the API (today only by id) and `reference` on withdrawals is optional —
  say so on the screen. Refusals 7, 8.
- **S6 — Webhook config = URL + secret issued together** (writes
  `webhookSecret`, encrypted at rest as the schema promises; nothing
  encrypts it today — measure the AEAD claim before trusting it). Refusal
  11. Unblocks the dispatcher that currently exhausts every delivery.
- **S7 — Sandbox that means something:** `environment=test` routed to a
  test-chain adapter (or a deterministic mock observer that "confirms" a
  deposit on request) and a separated allowance; only then the "get a
  sandbox key" button. Refusal 4.
- **S8 — Docs page** generated from the §2 table and the error-code list
  (`errors.ts`), so it cannot drift from the routes.
- **S9 — Rate limiting** (row 8) or removal of the two columns; a panel
  must not display an unenforced number (refusal 12).
- **S10 — Rotation** (`successorKeyId` written, allowance and addresses
  inherited) — the only thing that makes refusal 3 relaxable.

Design-lead owns the look of S2-S8; nothing above specifies one.

---

## 7. WHAT NEEDS IBRAHIM, in one Arabic line each (for the coordinator to carry)
- ~~تغيير قاعدة: الجملة "Not a public gateway…" في `CLAUDE.md` الخاص بـ SamaPay تتعارض مع هدف اللوحة، وتعديلها بيدك.~~ *(أُجيب 2026-09-06 بيده — القاعدة الجديدة في `CLAUDE.md`.)*
- قاعدة بيانات SamaPay الإنتاجية + أول migration (وستحمل جداول الحسابات).
- سجل DNS لـ `pay.mntad.com` (لا يوجد الآن) + vhost + PM2.
- بيانات OAuth من Google لنطاق `pay.mntad.com` (عميل جديد في Google Cloud).
- قرار S0: تطبيق Next.js منفصل للوحة، أم صفحات داخل خدمة Hono.

## 8. NEGATIVE CLAIMS, WITH THEIR SCOPE
- "nothing branches on `environment`": grep over `src/**/*.ts` at 836c859
  for `environment|"test"|'test'`, excluding `keys/` and `admin-keys.ts`
  → only `auth.ts:11,27`. Falsifier: any other hit.
- "webhookSecret is never written": grep over `src`, `scripts`, `prisma`
  (`*.ts`, `*.sql`) for `webhookSecret` → reads only. Falsifier: a `data: {
  webhookSecret` anywhere.
- "no rate limiting": grep `429|rps` over `src/http` → 0.
- "no human model": every `model` in `prisma/schema.prisma` listed in §0.2.
- "no dahabi auth code": `find /www/wwwroot -maxdepth 2 -iname '*dahabi*'`
  → three vhosts, none with a package.json; contents read.
- "pay.mntad.com has no DNS": `getent hosts pay.mntad.com` → empty
  (control: `mntad.com` resolved).
