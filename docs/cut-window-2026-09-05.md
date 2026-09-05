# THE CUT WINDOW — derived from the steps, not from the earlier figures

**providers-rules, 2026-09-05. FOR IBRAHIM TO BOOK AGAINST.**

## ⚠️ WHAT THIS SESSION RAN vs WHAT IT RELAYED

***RAN by me, 2026-09-05, read-only against production and the tree:***
the crypto module's size and import seam; every file that imports
`@/lib/crypto`; the live crypto tables' row counts; deposit and
withdrawal activity; the four SamaPrime deploy durations today.
***RELAYED:*** the "6–9 working days / window in hours" figures from the
earlier plan — **treated below as a claim, and the window number does not
come from them.**

---

## 1. THE ANSWER FIRST

    HOW LONG          ~25 minutes, and it is ONE deploy long only if we do the
                      deploy BEFORE the window (§4). Otherwise ~60.
    WHAT IS DOWN      *** ONE CUSTOMER PAGE. *** Not the site.
    ROLLBACK          ~3 minutes, and NOTHING is destroyed to make it possible.

## 2. WHAT IS ACTUALLY UNAVAILABLE — MEASURED, AND MUCH SMALLER THAN "THE SITE"

Every file importing `@/lib/crypto`, classified:

    CUSTOMER-FACING PAGES                                    1
      app/[lang]/(dashboard)/wallet/deposit/page.tsx
    CUSTOMER-FACING API                                      3
      /api/wallet/deposits · /api/v1/wallet/deposits · …/[id]
    ADMIN ONLY (his own screens)                             5 pages + 4 routes
      /admin/unlock · /admin/crypto · /admin/hot-wallet · /admin/reconciliation · admin layout
    INDIRECT, code path exists                               lib/providers/payment/{bsc,tron}-usdt
      reachable only from partner transfers, which have no signed provider
      agreement and are unconfigured (docs/TRANSFERS.md)

⇒ **A CUSTOMER CANNOT SEE A DEPOSIT ADDRESS FOR ~25 MINUTES.** The store,
orders, SMS/OTP, internal transfers, the merchant panel, sign-in and every
storefront keep serving. ***A SITE-WIDE MAINTENANCE PAGE WOULD BE
OVER-BROAD BY A FACTOR OF THE WHOLE PRODUCT*** — gate the deposit page and
its three routes, nothing else.

**AND THE PATH IS QUIET.** MEASURED: 29 deposits ever, 16 in the last 30
days, the newest on 2026-09-01 — roughly **one deposit every two days**.
8 withdrawals ever. **A 25-minute window has a ~1.7% chance of a deposit
arriving inside it**, and even then nothing is lost: the chain keeps the
transfer and the observer's cursor picks it up on the other side. That is
what a scan cursor is FOR.

## 3. ⚠️ TWO CONSTRAINTS THE EARLIER PLAN DOES NOT CONTAIN, BOTH MEASURED

### 3.1 `SEED_ENCRYPTION_KEY` CANNOT LEAVE SAMAPRIME

⚠️ ***THIS SECTION FIRST SAID "THREE CONSUMERS, ONE MOVING". THAT WAS AN
UNDERCOUNT AND IT IS CORRECTED HERE RATHER THAN QUIETLY WIDENED*** — the
coordinator challenged the number and it did not survive. **13 files
reference the key; SIX are inside `lib/crypto` and move, SEVEN STAY.**
MEASURED 2026-09-05 by me, `grep -rl 'SEED_ENCRYPTION_KEY\|getSeedEncryptionKey'`
over `lib/` and `app/`, with a control (the same probe finds `DATABASE_URL`):

    MOVES — inside lib/crypto (6)
      config.ts · errors.ts · seed/{cli-generate,master-seed,passphrase,vault}.ts

    *** STAYS — outside lib/crypto (7) ***
      lib/vouchers/code.ts                      voucher codes
      lib/auth/totp.ts                          2FA SECRETS
      lib/cards/card-crypto.ts                  CARD DATA AT REST
      lib/admin/provider-config-crypto.ts       ProviderConfig secrets
      lib/db/merchant-provider-credentials.ts   merchant credentials
      lib/providers/merchant-source/sync.ts     the mismatch-throw path
      lib/providers/technorex-client.ts         (the seventh — not in the
                                                 first corrected list either)

***SO "ONE PRIVATE KEY, ONE PLACE" IS TRUE OF THE MASTER SEED AND FALSE OF
THE ENCRYPTION KEY.*** A cut that removes `SEED_ENCRYPTION_KEY` from
SamaPrime's `.env` breaks **2FA enrolment, card decryption, voucher codes,
provider secrets and merchant credentials**. **The env var stays in both
services; only the seed moves.**

⚠️ **AND THE FAILURE MODE IS WORSE THAN "NOT AT BOOT" — IT IS SCATTERED.**
`lib/vouchers/code.ts` states the security argument itself: the key lives
in `.env` and never in the database, so *"a stolen dump is inert"*. The
consequence is that a missing key breaks nothing at startup and everything
later, ONE FEATURE AT A TIME: a customer's 2FA fails on Tuesday, a card
page throws on Wednesday, a voucher cannot be reprinted on Thursday — at
different times, to different people, **with nothing connecting them.**

Blast radius in rows, production: `provider_configs` with a stored secret
2 · `vouchers` 2 · `crypto_addresses` 194. *(The row counts are the
coordinator's measurement, relayed; the file list above is mine.)*

### 3.2 THE SEED IS COPIED, NOT MOVED, AND NOT DELETED IN THE WINDOW

Destroying SamaPrime's copy inside the window makes the window
unrollbackable against a module whose own `docs/SECURITY.md` says the seed
has **no recovery path**. Copy it; disable SamaPrime's crypto with
`CRYPTO_ENABLED=false`; leave the copy dormant. **Deleting it is a
separate, later, deliberate act with its own approval** — the contract
step. That is the whole reason the rollback below costs three minutes.

## 4. THE SHAPE THAT MAKES IT 25 MINUTES INSTEAD OF 60

***DEPLOY THE CLIENT WIRING DARK, BEFORE THE WINDOW, BEHIND A FLAG.***
A SamaPrime deploy is the long pole and it is measured, not guessed —
today's four took **25m50s, 23m51s, 29m36s, 24m51s**. Done inside the
window it doubles the outage; done before it, the window is a flag flip
and a restart. This is expand → deploy → contract applied to a cutover.

### BEFORE THE WINDOW — nothing is degraded, nothing is irreversible

    1. SamaPay production DB + first migration                    HIS LINE
    2. SamaPay on pay.mntad.com: nginx vhost + PM2                HIS LINE
    3. SamaPrime's client key, minted from the CLI                HIS LINE
    4. SamaPrime deploys the SamaPay client behind a flag, OFF    ~25 min, no outage
    5. Export the 192 addresses + 2 derivation counters to JSON   read-only
    6. REHEARSE the import against samapay_sandbox                already scripted

### INSIDE THE WINDOW

    1. Gate the deposit page + its 3 routes                        ~1 min
    2. CRYPTO_ENABLED=false, restart — SamaPrime's scanner stops   ~2 min
       (two scanners on one chain is the one thing that must never overlap)
    3. Assert no deposit is mid-credit: zero rows in a
       non-terminal state                                          ~1 min
    4. Seed COPIED into SamaPay's vault; unlock by his passphrase   ~5 min
    5. Import 192 addresses + 2 counters; assert both counts        ~2 min
    6. Start SamaPay's observer; prove it sees the same chain head
       as SamaPrime's last cursor                                   ~5 min
    7. Flip SamaPrime's flag ON, restart                            ~2 min
    8. ARRIVAL CHECK — issue an address through SamaPrime, read
       /balance, render the deposit page                            ~5 min
    9. Ungate                                                       ~1 min
                                                            TOTAL  ~24 min

⚠️ **THAT TOTAL IS A SUM OF PARTS AND THEREFORE AN UPPER BOUND ON THE
STEPS AND A LOWER BOUND ON THE HOUR** — it excludes reading between steps
and any pause to think. **Book 45 minutes; expect ~25.** The honest
number is the one with the reading time in it.

## 5. ROLLBACK — ~3 MINUTES, BECAUSE NOTHING WAS DESTROYED

    flag OFF · CRYPTO_ENABLED=true · restart · ungate

SamaPrime is byte-for-byte as it was: the seed was copied not moved, the
192 addresses were copied not moved, and no SamaPrime row was rewritten.
**The rollback does not depend on SamaPay being healthy** — it does not
touch SamaPay at all.

***THE ONE-WAY DOOR IS NOT IN THIS WINDOW.*** It is deleting SamaPrime's
seed copy afterwards, and that is deliberately a separate decision.

## 6. WHAT I HAVE NOT MEASURED

- The step-4 code move itself (lib/crypto → SamaPay) is **29 files,
  4,930 lines**, and I have not attempted it. The 6–9 day estimate for it
  is not mine and I neither confirm nor dispute it.
- Whether the observer's first scan reconciles exactly against
  SamaPrime's stored cursor. **That is step 6 of the window and it is the
  step most likely to overrun**; it is also the one where stopping and
  rolling back is cheapest.
