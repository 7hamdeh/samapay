# AMENDMENT: THE WINDOW UNDER RULING (ج) — 2026-09-06

**providers-rules, owner of `docs/cut-window-2026-09-05.md`. Answering the
question he asked: does the plan permit (ج)? MEASURED, not opined.**

> **#24, his words:** *"new seed for SamaPay, SamaPrime keeps the old one and
> its 194 addresses. I WILL NOT DUPLICATE THE KEYS TO 97 CUSTOMERS' FUNDS SO A
> PORT CAN BE CONVENIENT. One system, one set of keys, ever."*

**RE-MEASURED BY ME against production, 2026-09-06, rather than relayed:**

    crypto_config rows (seeds)   1
    crypto_addresses             194   = 97 BEP20 + 97 TRC20
    distinct users               97
    credited deposits            29, $246.32

---

## ══ FOR IBRAHIM ══

### THE ANSWER: YOUR RULING DOES NOT BREAK THE PLAN. IT DELETES THE DANGEROUS HALF OF IT.

I expected to report damage. **The opposite is true**, and the reason is worth
one sentence: my plan needed a window because it was going to **switch the
deposit path over**. Yours never switches it — it only changes **who issues the
NEXT address**. Nothing that exists moves, so nothing that exists has to stop.

**What your ruling removes outright:**

- **The step that turned SamaPrime's deposit scanner OFF.** That was the single
  most destructive line in the plan and the reason a window existed at all.
  Under your ruling it must NOT happen: your 97 customers' addresses keep being
  watched, permanently, until they are drained.
- **The step that copied the seed.** Gone.
- **The step that imported your 194 addresses into SamaPay.** Gone — and it was
  the duplication you refused, wearing a different name.
- **The ~25 minute outage for the deposit page.** Existing customers never lose
  their address, so there is nothing to gate for them.

**And the figure I gave you is now obsolete in the good direction.** I said a
25-minute window carried a ~1.7% chance a deposit lands inside it. **Under your
ruling that risk is not reduced, it is removed** — the path is never down.

### ⚠️ WHAT YOUR RULING INTRODUCES, AND ONE OF IT NEEDS YOUR DECISION

**Two systems now watch the same two blockchains at the same time, forever.**
That is safe **only** because they watch completely separate lists of addresses.
This must be a checked rule, not a hope — I am building the check that proves no
address can ever exist in both.

***AND THE ONE THING I CANNOT DECIDE FOR YOU:*** a customer who already has a
deposit address will, in time, have a SECOND one from the new system.

    · does the old address stay visible to them, or disappear?
    · if they send to the old one after the new one appears, it still
      works — is that what you want it to do?
    · who tells them anything, or does nobody?

**I am not guessing at this. It is what a customer sees on the money path.**

### WHAT I NEED FROM YOU TO GENERATE THE SEED YOUR WAY

**You said: "I hold it. Print it once, on my screen, never in a log, never in a
backup, never in a message."**

I will write a generator that prints the recovery words **once, to your screen
only**. It will not appear in any log, any file, any message, or any session's
transcript — **including mine.** I will not see it.

⚠️ **One correction to make sure we mean the same thing, because getting it
backwards is very expensive in one direction:** the ENCRYPTED seed *must* live
in SamaPay's database and *will* be inside database backups — exactly as
SamaPrime's is today. That is correct and I will not "fix" it. Without it,
SamaPay cannot restart. **Your sentence is about the plain words, and only the
plain words.**

**And you must write the words down somewhere physical before we continue.** If
they are lost, every address SamaPay ever issues becomes unrecoverable. There is
no reset.

---

## ══ FOR THE ADVISOR ══

### WHAT CHANGES, LINE BY LINE, IN `docs/cut-window-2026-09-05.md`

    §3.1  SEED_ENCRYPTION_KEY cannot leave SamaPrime   UNCHANGED, and now
          trivially satisfied — nothing leaves.
    §3.2  "the seed is COPIED, not moved"              RETIRED IN FULL.
    §4 step 4  "seed COPIED into SamaPay's vault"      REPLACED: generate a NEW
          seed in SamaPay, plaintext printed once to his TTY.
    §4 step 5  "import 192 addresses + 2 counters"     DELETED. Importing them
          is the duplication (ج) refuses.
    🔴 §4 step 2  "CRYPTO_ENABLED=false, SamaPrime's scanner stops"
          MUST NOT HAPPEN. Inverted: SamaPrime's scanner MUST KEEP RUNNING
          until the last legacy address is drained and closed.
    §4 step 6  "two scanners on one chain must never overlap"
          RE-DERIVED, see below. It is now a permanent condition, not a
          forbidden one.
    §2    the ~1.7% arithmetic                          OBSOLETE. It priced an
          outage that no longer occurs.
    §5    rollback ~3 min                               SIMPLER: point issuance
          back at SamaPrime. No seed to un-copy, no import to undo.

### 🔴 THE ONE CLAIM THAT MUST BECOME AN ASSERTION

My plan said *"two scanners on one chain is the one thing that must never
overlap"*. **Under (ج) two scanners run on both chains permanently.** That is
safe **iff the address sets are disjoint** — SamaPay's observer scans only rows
in its own `addresses` table, SamaPrime's only its `crypto_addresses`.

***DISJOINTNESS IS CURRENTLY TRUE BY CONSTRUCTION AND BY NOTHING ELSE:***
different seeds produce different addresses. **That is a cryptographic argument,
not a checked one**, and the failure mode if it were ever violated is a deposit
credited TWICE, in two systems, to two balances.

⇒ **A cross-system check belongs in the plan: assert the intersection of the two
address sets is empty, with a control proving the comparison can find a match.**
Cheap, and it is the only instrument that would ever catch a seed being reused.

### WHAT I GOT WRONG, PLAINLY

**I recommended (أ) to him directly, in his terminal, with the reason.** My
frame was *"copy is non-destructive, SamaPrime keeps its own"* — technically
true and the wrong quantity. ***THE RIGHT QUANTITY IS HOW MANY PLACES 97
CUSTOMERS' FUNDS CAN BE OPENED FROM, AND MY RECOMMENDATION DOUBLED IT.*** He
measured that and I had not. This is this repository's own "derive the quantity
the decision is about", and I derived a different one.

### WHAT I AM BUILDING NEXT, AND WHAT I AM NOT

**Building:** the seed generator with a TTY-only plaintext path; the
cross-system disjointness check; the round trip re-run against the real seed
once it exists.

**NOT building, deliberately:** anything that touches SamaPrime's 194 addresses,
its scanner, or its seed. Under (ج) they are out of scope by ruling, not by
preference.

⚠️ **AND MY EXISTING PRECONDITION GUARD IS NOW LOAD-BEARING.**
`verify-derive-roundtrip.ts` refuses to run if `crypto_config` holds a row.
Written when the table was empty and cost nothing; **once his seed is in there
it is the thing standing between a test fixture and his real key material.**
