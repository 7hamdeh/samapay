# pay.mntad.com merchant dashboard — phase 1, built, awaiting approval

Branch `feat/pay-dashboard` @ worktree `/www/wwwroot/samapay-wt/pay-dashboard`, based on `origin/main` (`899ecbc`).
Nothing was deployed, no process restarted, no migration applied, no `.env` read or written.

## 1 · What this phase delivers (code, all behind `PANEL_ENABLED`, default OFF)

| Area | Files | Owner's scope item |
|---|---|---|
| Panel config, fail-closed | `src/panel/config.ts` | — |
| Email codes (argon2, single-use, supersede, attempt cap) | `src/panel/login-code.ts`, `src/panel/email.ts` | sign up / log in, POST only, never codes in URLs |
| Sessions (host-only cookie, token stored as sha256, CSRF, revoke-all) | `src/panel/session.ts` | — |
| Sign-in state machine, optional TOTP | `src/panel/auth.ts`, `src/panel/totp.ts`, `src/panel/totp-management.ts` | 2FA optional |
| MNTAD handoff consume, single spend ledger | `src/panel/handoff-ticket.ts` | SSO "get an API key" from a stores.mntad.com account |
| Keys: list / mint / revoke, membership-scoped | `src/panel/keys.ts` | create/revoke keys, shown once, hashed |
| Webhook URL+secret (atomic), test-send through the real dispatcher, delivery log | `src/panel/webhook.ts` | webhook URL + secret + test button |
| Read-only views: balance, deposits, intents, addresses, audit | `src/panel/read-views.ts` | payment intents + deposits, permanent addresses, balance, audit log |
| SSRF guard (ported from MNTAD verbatim) + webhook-target composition | `src/net/outbound-address-guard.ts`, `src/net/webhook-target.ts` | rate limits, safety |
| Rate buckets with derived numbers | `src/panel/rate-limit.ts` | rate limits |
| Trusted client IP (X-Real-IP only) | `src/panel/request-ip.ts` | — |
| Mail over `/usr/sbin/sendmail`, no new dependency | `src/panel/mailer.ts` | — |
| Panel HTML shell + JSON routes, docs links, en/ar | `src/render/panel-shell.ts`, `src/http/routes/panel/index.ts`, `src/http/app.ts` | links to the docs |
| Docs links | the shell links `/docs.html`, `/docs.ar.html`, `/health` | — |

**No money movement exists in this phase.** `POST /v1/withdrawals` stays unmounted
(`src/http/app.ts:8-11`) and no panel route reaches it.

Suites (each runs on a throwaway cluster via `scripts/throwaway-sandbox.ts`):

```
verify-panel-auth.ts             37 passed / 0 failed / 0 VOID
verify-panel-tenant-isolation.ts 18 passed / 0 failed / 0 VOID
verify-panel-handoff-ticket.ts   19 passed / 0 failed / 0 VOID
verify-panel-outbound-guard.ts   91 passed / 0 failed / 0 VOID
verify-auth-and-keys.ts          14 passed / 0 failed          (pre-existing suite, unchanged)
verify-merchant-provisioning.ts   9 passed / 0 failed          (pre-existing suite, unchanged)
```

`verify-api-contract.ts` = **91 passed / 3 FAILED**. The three failures are pre-existing on
`main`, not this branch: `899ecbc` narrowed `/health` to `{ok}` for public callers and did not
update that test (its last commit is `7830080`), and `main` also fails `tsc --noEmit` at
`src/http/routes/health.ts:90` before this branch touched anything. `git status` shows this
branch changes only `prisma/schema.prisma`, `src/http/app.ts` (conditional mount) and
`src/keys/issue.ts`. **Fixing that stale test is not in my scope for this phase and I did not
touch it.**

## 2 · THE SCHEMA CHANGE — this is what needs your keystroke

`prisma/migrations/20261001000000_panel_identity/migration.sql`, generated FILE-TO-FILE
(`prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma`)
against a shadow database on a throwaway cluster — `scripts/gen-panel-migration.ts` refuses to run
unless it can prove it is on a `throwaway-pg` cluster, and refuses to write the file if the diff
contains any `DROP`/`TRUNCATE`/`DELETE`/`NOT NULL` relaxation. It is EXPAND-only:

* 2 new enums: `AccountRole ('owner','viewer')`, `LoginCodePurpose ('sign_up','sign_in')`
* 6 new tables: `accounts`, `account_clients`, `login_codes`, `panel_sessions`,
  `panel_backup_codes`, `handoff_tickets`
* `client_keys` +3 nullable/defaulted columns: `created_via` (default `'cli'`, so every existing
  row keeps its truth), `created_from_ip`, `webhook_updated_at`
* `webhook_deliveries` +1 column: `test_only BOOLEAN NOT NULL DEFAULT false`
* FKs from the new tables to `accounts` / `clients` (CASCADE only inside the panel's own
  session/backup-code tables; `RESTRICT` everywhere a membership or a client is referenced)

Full SQL is in that file — 171 lines, and it is the thing to approve.

## 3 · Deviations from `pay-dashboard.md` — each is deliberate, each needs your eye

1. **`issuedVia` gains the value `'panel_owner'` instead of the panel reusing `'cli'`**
   (`src/keys/issue.ts:34`). The plan (B.6 step 9) says keep `'cli'` so the union is not widened.
   That is unsafe: `issueKey` refuses `keys.issue` by testing `issuedVia !== "cli"`
   (`issue.ts:32-34`), so a panel mint labelled `'cli'` would inherit the CLI's one unforgeable
   power — minting an admin key that can mint admin keys. The value is a privilege, not a label.
   `created_via` is still written as the plan wanted (provenance that does not rewrite history);
   assertion 1c in `verify-panel-tenant-isolation.ts` pins this.
2. **The handoff ticket carries `iat` and `email`, which the plan's shape lacked.**
   Without `iat` a consumer can only compare `exp` to now, so an issuer that signs
   `exp = now + 3600` produces an hour-long "60 second" ticket that passes every check — the
   60 s rule would have been a comment. `email` is what lets SamaPay link the `Account` without
   inventing an identity from a request body. Assertion 8b refuses a long-lived ticket.
3. **SamaPay owns the spend ledger** (`src/panel/handoff-ticket.ts`, review B2). The INSERT on the
   ticket's own `jti` *is* the atomic spend, inside the transaction that creates the session.
   **The MNTAD-side issuer must be built to match: sign, never record consumed-state.**
4. **TOTP is implemented in-house** on `node:crypto` (RFC 6238, SHA-1, 30 s, ±1 step) rather than
   adding `otplib`, and the secret is AEAD under a NEW HKDF subkey
   `samapay-panel-totp-v1` of `SEED_ENCRYPTION_KEY` — the same domain-separated pattern as
   `samapay-webhook-secret-v1`. Assertions 11, 11b, 12, 12b (including: a blob that does not
   decrypt is a REFUSAL, never a bypass, and never a fallback to plaintext).
5. **Mail goes through `/usr/sbin/sendmail`** (measured present) with a `Mailer` port and a fake
   for tests, because sama_pay has no SMTP dependency and adding one is a supply decision.
   `PANEL_MAIL_TRANSPORT=none` (the default) REFUSES to send, so a misconfigured production host
   cannot quietly mail nobody (assertion 15c).
6. **`ClientKey.monthly_limit` is not displayed anywhere in the panel.** It remains a schema lie
   (no code enforces it). Enforce-or-remove is still your ruling (roadmap R11).
7. **The SSRF guard is wired at SAVE and at TEST-SEND, not yet at DISPATCH.** `attemptDelivery`
   still POSTs to whatever the row says. The panel's merchant-facing door is closed; the deeper
   fix touches the path that credits a store, so it needs the money-path review pass rather than
   a quiet edit. It is the first item in §4.

## 4 · What must happen before this can be turned on

| # | Item | Whose keystroke |
|---|---|---|
| 1 | `prisma migrate deploy` in samapay for §2 | **Ibrahim** |
| 2 | Generate `MNTAD_SAMAPAY_HANDOFF_SECRET` (≥32 chars) and write it into BOTH `samapay/.env` and `samaprime.com/.env` | **Ibrahim** |
| 3 | nginx: `pay.mntad.com` currently proxies only `/v1/` and `/health`; `/auth/*` and `/panel/*` reach the static root and 404. Needs, before the `location /` block, e.g. `location ^~ /panel/ { limit_req zone=pay_api burst=10 nodelay; proxy_pass http://127.0.0.1:3090; … }` and the same for `/auth/` (plus `location = /panel`) | **Ibrahim** (shared infra) |
| 4 | `PANEL_ENABLED=1` — nothing happens until then | **Ibrahim**, after 1-3 |
| 5 | Wire `assertWebhookTargetUrl` into `src/webhooks/dispatch.ts` at send time, with its own DNS budget (a hung resolver + `CLAIM_LEASE_MS=60_000` double-attempts a delivery) | money-path review |
| 6 | MNTAD side: the ticket issuer (`lib/auth/samapay-handoff.ts`, `/api/internal/samapay/issue-handoff`), resolving `samapayClientId` from the store's own AEAD credential, + the "Connect SamaPay" card on `/merchant/deposits` (must NOT reverse the admin-only refusal in `lib/actions/merchant-provider-credentials.ts:44-55`) | separate phase, MNTAD repo |
| 7 | One read-only `_prisma_migrations` dump on samapay's DB (review B1: `scan_gaps` applied is still unproven) | read-only, needs your approval to run |
| 8 | A CSP on the cookie-bearing `/panel`+`/auth` responses, and a browser pass on the HTML shell | not done — see §5 |

## 5 · What I did NOT verify (scope statement, so silence is not approval)

* **The HTML shell has never been rendered in a browser.** It needs nginx changes (§4.3) to be
  reachable at all. The JSON routes are exercised by tests; the visual layer is not.
* No production DB was read, so nothing here is claimed about live client/key/allowance counts.
* The rate limits are in-process, correct for one API process (`ecosystem.config.cjs instances:1`),
  and are throttles, not lockouts — a restart forgets them. Same caveat `auth.ts:103-133` carries.
* No socket pinning in the guard, so DNS rebinding between validate and connect remains open
  (the ported file says so). It matters more here than in MNTAD because dispatch retries one URL
  up to 8 times over two days.
* A merchant's FIRST key stays CLI-only forever: it is the one that creates the `Client` and sets
  `fee_bps`/`min_intent`/`max_intent`/`enabled_chains` via `applyTerms`. The panel manages
  second-and-later keys, webhooks, and the read views for a client Ibrahim has already provisioned.
* `docs/AUTH.md`, `docs/SECURITY.md` on this repo were not read end-to-end.

## ملخص عربي (هذا الملف)

بُنيّت المرحلة الأولى من لوحة التاجر على `pay.mntad.com` بالكامل داخل خدمة SamaPay (Hono)، وهي
مطفأة افتراضياً: لا تُفتح إلا بـ `PANEL_ENABLED=1`. تشمل: تسجيل/دخول برمز بريد (argon2، استخدام
واحد، POST فقط، الرمز لا يظهر في أي رابط أبداً)، جلسات بملف تعريف ارتباط محصور على المضيف فقط،
2FA اختيارية (TOTP مكتوبة داخلياً ومشفّرة AEAD)، مفاتيح API (إنشاء/إلغاء، يظهر النص مرة واحدة،
التخزين hash)، ويب-هوك (رابط + سرّ ذرّتهما معاً، زر اختبار يمرّ في مسار الإرسال الحقيقي، سجل
التسليم)، وشاشات للقراءة فقط: الرصيد بحسابه الظاهر، الإيداعات، طلبات الدفع، العناوين الدائمة،
سجل التدقيق. الحماية من SSRF منقولة حرفياً من SamaPrime، والـ IP الموثوق هو `X-Real-IP` وحده.

النتائج: 165 تأكيداً في أربعة أطقم جديدة ناجحة 0/165 فشل، والأطقم القديمة موجودة بلا تغيير
(14 و 9 ناجحة). ثلاثة إخفاقات في `verify-api-contract.ts` هي على `main` أصلاً بسبب تضييق
`/health` في `899ecbc` دون تحديث الاختبار، و`main` يفشل `tsc` في `health.ts:90` قبل أي تعديل هنا.

بانتظار قراركم/تنفيذكم: (1) تطبيق الـ migration المولّد ملف-إلى-ملف (قائمة بالجداول والأعمدة،
بلا أي حذف)، (2) توليد `MNTAD_SAMAPAY_HANDOFF_SECRET` وتوزيعه على الطرفين، (3) إضافة nginx
لمسارَي `/panel/` و`/auth/`، (4) تشغيل `PANEL_ENABLED=1`، (5) ربط حارس الويب-هوك عند الإرسال
(يمسّ مسار التسوية — يحتاج مراجعة مسار المال)، (6) جهة SamaPrime: مصدر التذكرة وزر «Connect
SamaPay». المفتاح الأول لأي تاجر يبقى عملاً خطّيّا بيد إبراهيم لأنّه يضبط العمولة والحدود.
