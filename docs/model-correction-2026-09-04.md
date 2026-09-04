# SamaPay's client model, corrected — assessment. NO CODE CHANGED.

**Ibrahim, 2026-09-04, verbatim:** *"SamaPrime accounts and SamaPay accounts
are SEPARATE SYSTEMS with no link. SamaPrime is ONE client of SamaPay with
ONE key; it distributes internally to its merchants by reference — a
merchant never knows SamaPay exists. External site owners (dahabi, others)
will register on SamaPay's own site later with their own accounts and mint
their own keys. Ignore my earlier 'store the owner's email so they find
their keys later' — v1 stores whatever identifies the CLIENT, and SamaPrime
is one client, not many."*

Written to a file because a message-only deliverable does not survive a
context reset. Nothing here is applied.

## 1. WHAT IS ALREADY RIGHT — most of it, and not by luck

MEASURED across the built tree:

    allowance          read(keyId) / reserve(lock on keyId)   PER KEY ALREADY
    reference          2 hits in src/allowance/*: carried onto the withdrawal
                       row, NEVER read as a bound                AN INDEX, NOT A RULE
    addresses          (key, reference) at derivation time       exactly "distributes by reference"
    webhooks           per client key                            one endpoint, SamaPrime fans out
    auth/idempotency/  key-scoped throughout, no merchant model anywhere
    audit/observer/
    sender/worker/
    reconciler
    cutover            192 legacy addresses under "the platform key" — now SIMPLER,
                       because the platform key IS SamaPrime's one key

**SamaPay never modelled merchants in the money path.** The correction lands
almost entirely in naming and in one dead route.

## 2. BUILT FOR THE RETIRED MODEL — four items, none applied to any database

| # | what | verdict |
| --- | --- | --- |
| 1 | `clients.samaprime_merchant_id` — *"the SamaPrime merchant this client IS"* | **DROP.** No client is a merchant. |
| 2 | `ClientKind.merchant` | **RETIRE the value.** v1 kinds: `platform` (SamaPrime) and `partner` (dahabi and whoever registers later). |
| 3 | `POST/DELETE /admin/clients/:id/keys` + `issued_via: 'samaprime_admin_action'` | **KEEP THE CODE, UNMOUNT THE ROUTE.** Its only caller was SamaPrime's merchant-enable action, which no longer exists; keys now come from the CLI (his hand). A mounted route with no caller is this repo's "a component looks finished when the thing that would expose it is disabled" — and it is attack surface for nothing. The mechanism is what SamaPay's own registration site will need later. |
| 4 | fixtures/suites using `kind: "merchant"` | cosmetic, follows from 2 |

Nothing above has touched a database — no DB exists — so all four are file
edits, free, and the first migration is still a single unapplied file.

## 3. ⚠️ THE SHARP QUESTION: ONE ALLOWANCE PER KEY, OR PER (KEY, REFERENCE)?

**ANSWER: PER KEY. `reference` must stay an index and must never become a
bound.** Four reasons, the first decisive.

1. ***PER-REFERENCE WOULD REFUSE LEGITIMATE WITHDRAWALS.*** Money EARNED
   inside SamaPrime — a merchant's margin on a sale, a referral commission,
   a balance received by internal transfer — has NO on-chain inflow under
   its own reference. Under a per-reference bound it could never leave.
   SamaPrime's own approved model (rule 5) bounds the exit against
   attributable inflow at the PLATFORM level and explicitly permits a
   merchant to create value; a per-reference bound at SamaPay contradicts
   it on day one, and the symptom is a customer's money stuck with no
   stated cause.
2. **TWO CALCULATORS FOR ONE MONEY RULE.** SamaPrime's exit bound is being
   built with its own attribution semantics. A second, differently-derived
   bound on the same money is the display-vs-charge divergence this
   codebase names repeatedly — and here the divergence surfaces as a
   REFUSED legitimate withdrawal, invisible until someone is stuck.
3. **SAMAPAY CANNOT KNOW SAMAPRIME'S RULE.** A merchant never knows SamaPay
   exists; symmetrically SamaPay must not model merchants. The moment
   `reference` becomes a bound, SamaPay is asserting it knows what that
   string means.
4. **THE ONE RULE STILL HOLDS WHERE SAMAPAY CAN ENFORCE IT:** SamaPrime
   cannot withdraw more USDT than arrived through SamaPrime. SamaPay holds
   the keys, so that bound is unforgeable — which is the whole point of
   moving crypto out of SamaPrime.

### ⚠️ THE HONEST COST OF THAT ANSWER, STATED RATHER THAN GLOSSED

SamaPay then does **NOT** stop SamaPrime from paying merchant A out of
merchant B's deposits. That protection lives entirely inside SamaPrime. If
a second line of defence is wanted, the instrument is **not** a bound — it
is **reporting**, §4.

## 4. THE GAP THIS CORRECTION EXPOSES — AND IT IS IN HIS OWN ORIGINAL SPEC

His minimal API listed `GET /balance (reference?)`. **It is NOT built:**
`src/http/routes/balance.ts` has zero occurrences of `reference`, and
`read()` is per-key only.

Under the retired model that was a nicety. **Under the corrected model it
is the ONLY instrument SamaPrime has to reconcile its internal per-merchant
ledger against SamaPay's independent numbers** — the "look for an
instrument on the other side" rule, applied to our own two systems.

⇒ **v1 should add a per-reference READ**: `GET /balance?reference=x` →
`{ received, withdrawn }` for that reference, **explicitly labelled NOT an
allowance** (the allowance is per key and there is exactly one), so no
future reader mistakes it for a bound. That needs a small addition to
value-model's module; her module, her call.

## 5. ⚠️⚠️ THE DECISION THAT CANNOT BE MADE LATER: WHAT GOES IN `reference`

Attribution is created at derivation time and **cannot be recomputed**. This
is `docs/scratch/the-allowance-has-no-source-2026-09-03.txt` exactly: one
address per user per chain, no merchant signal, ***NOT RECOVERABLE
RETROACTIVELY***, $246.32 unattributable to this day.

    reference = userId       -> per-merchant reconciliation impossible later
    reference = merchantId   -> per-user reconciliation impossible later
    reference = "m:<merchantId>/u:<userId>"  -> BOTH, forever

**RECOMMENDATION: the composite, structured, opaque to SamaPay.** SamaPay
indexes the string and never parses it; SamaPrime aggregates by prefix. It
costs nothing today and it is unrecoverable if skipped. **This must be
settled before the first address is issued, not before launch.**

## 6. WHAT I HAVE NOT CHANGED

Nothing. No code, no schema, no route. This file is the reading, for
agreement first.
