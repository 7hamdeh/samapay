# THE SEED MOVE — PLAN, ANSWERING HIS FIVE QUESTIONS

**providers-rules, 2026-09-06. Ruling #27: ONE seed, living in SamaPay;
SamaPrime becomes an ordinary client taking payments over the API.**

**Nothing in this plan has been run. Every number below was measured today.**

---

## ══ FOR IBRAHIM ══

### 🔴 FIRST — A QUESTION THAT OUTRANKS THE WHOLE PLAN

**Do you still have the 24 words for SamaPrime's ORIGINAL seed, the one from
August that your 97 customers' addresses come from?**

I checked the code that made it. It says, in its own words, that the mnemonic is
*"never stored by this codebase in any form"* — only the derived seed is kept.
**Turning 24 words into a seed is one-way.** So:

> ***THOSE 24 WORDS CANNOT BE PRINTED AGAIN. NOT BY ME, NOT BY YOU, NOT BY ANY
> SCRIPT. They exist only on the paper you wrote in August, or nowhere.***

**This changes your point 5.** You asked that the seed be *"printed once during
the move"*. **For this seed that is impossible** — there is nothing to print. The
move carries the encrypted material, not words.

⚠️ **If that August paper is lost, the move is still possible and the system
keeps working — but you would have no offline backup of 97 customers' funds at
all.** I would want that fixed before anything else, and it is a different job.

### THE SEED DOES NOT TRAVEL AS PLAINTEXT. THE ABILITY TO OPEN IT TRAVELS.

The seed sits in SamaPrime's database inside a locked box. The box and its key
are separate things. **So we copy the locked box, and copy the key — and the
seed itself is never unlocked, never in plain form, never on a screen, never in
a file, at any point.**

    what moves       the locked box (a copy) and its key
    what never       the seed in readable form. It is never opened.
    happens

**That is safer than the version you asked for.** You expected to see words
during the move. **You will see nothing, because nothing needs to be shown.**

### ANSWERING YOUR FIVE, IN ORDER

**1 — HOW IT MOVES, AND WHAT SAMAPRIME KEEPS.**
SamaPrime keeps its copy throughout the transition. It is not deleted, not
touched. **What ends SamaPrime's ability to open the box is removing its key —
one line in a settings file, reversible in seconds.** That is the cut, and it is
the last step, not the first.

**2 — YOUR 194 EXISTING ADDRESSES.**
They keep receiving. **Nothing a customer has stops working, at any point** — an
address is just a place on the blockchain; it does not care which of our systems
is watching it.

The only real risk is **both systems watching the same address at once and
crediting the same deposit twice.** So they hand over: SamaPrime's watcher stops,
tells us the exact block it reached, SamaPay's watcher starts **from that same
block**. No gap, no overlap.

⚠️ **A deposit arriving during the handover is NOT LOST.** The blockchain keeps
it, and SamaPay picks it up from the handover block. **It may be credited a few
minutes late. It cannot go missing.**

**3 — ROLLBACK, AND YES, PROVEN BEFORE WE START.**
Rollback is: put SamaPrime's key back and restart it. **Seconds.**

You asked whether it is proven before rather than after. ***It will be. I will
rehearse the entire move — copy, cut, rollback — against the test database
first, and show you the result before we touch anything real.*** A rollback
first tried at the moment it is needed is not a rollback, and this project has
already been bitten by exactly that.

**4 — ORDER. AND THE CIRCLE YOU SPOTTED IS NOT REAL.**
You said the seed moves only after a real deposit lands in SamaPay. That looked
impossible, because taking a deposit seemed to need the seed.

***IT DOES NOT. WATCHING AN ADDRESS NEEDS NO KEY. Only creating one and spending
from one do.*** I measured this in the code.

So:

    1. SamaPrime — which already holds the keys — makes ONE new address
    2. SamaPay is told to watch it
    3. you send real USDT to it. Tron first.
    4. SamaPay sees it, credits it, and the balance appears

**The house takes a real deposit before a single key moves.** Your sentence
holds exactly: nothing is moved into a house that has never taken a deposit.

**5 — THE PAPER.** Covered above: for this seed there is nothing new to print.
Your existing August paper remains the only offline copy, and it stays exactly
as important as it is today.

### AND THE SEED YOU MADE AT 6:49 THIS EVENING

    fingerprint 02e0fb61 · 0 addresses · 0 deposits · nothing derived from it

**It is completely unused and harmless.** Under the new plan it has no job.
**I have not deleted it — it is your key material and your paper.** Say the word
and it goes, or it can sit there unused. **But it should not stay with no stated
purpose**, because the next person to find two seeds will not know which is real.

---

## ══ FOR THE ADVISOR ══

### THE MECHANISM, AND WHY NO PLAINTEXT EVER EXISTS

`saveMasterSeedConfig` stores `AES-256-GCM(seed_bytes, SEED_ENCRYPTION_KEY)`.
The blob is opaque to anyone without that key. **So the move is two copies and
zero decryptions:**

    1. SamaPrime.crypto_config.encrypted_master_seed  -> SamaPay.crypto_config
    2. SamaPrime's SEED_ENCRYPTION_KEY                -> SamaPay's .env

⇒ **`decryptSeed` is never called during the move.** The plaintext seed never
exists outside the memory of a process that is already entitled to it. **The
alternative — decrypt with SamaPrime's key, re-encrypt with SamaPay's — creates
a plaintext seed in a migration script, which is strictly worse for no gain.**

⚠️ **CONSEQUENCE, STATED RATHER THAN DISCOVERED LATER:** SamaPay adopts
SamaPrime's `SEED_ENCRYPTION_KEY`. Its own freshly-generated key (protecting the
inert `02e0fb61`) is superseded. **Both keys must be preserved until `02e0fb61`
is formally retired, or that seed becomes unopenable** — which matters only
because he holds paper for it.

### THE CUT IS THE KEY REMOVAL, NOT THE COPY

    COPY      additive, reversible, no behaviour change. Both systems can open
              the box. SamaPrime still serves every deposit exactly as today.
    PROVE     his real deposit, per item 4, using SamaPrime-derived addresses
    CUT       remove SEED_ENCRYPTION_KEY from SamaPrime's env; restart
    ROLLBACK  put it back; restart. Seconds.

**Expand → deploy → contract, applied to key material.** No step is wrong for
the code that is live while it happens.

### THE ONE THING THAT MUST NOT OVERLAP, AND HOW THE HANDOVER AVOIDS IT

Two scanners on one address set double-credit. **Each system's idempotency guard
is satisfied — `UNIQUE(chain, tx_hash)` per database — because neither can see
the other's rows.** Nothing detects it from inside either system.

    stop SamaPrime's scanner   record CryptoScanCursor.lastScannedBlock per chain
    import the 194 addresses   into SamaPay.addresses, legacyImport = true
    seed SamaPay's cursor      to EXACTLY that block, per chain
    start SamaPay's observer

**No gap (the cursor is handed over, not reset) and no overlap (only one scanner
runs at a time).** ⚠️ **And `scripts/verify-address-sets-disjoint.ts` INVERTS at
this point**: before the cut it asserts the sets are disjoint; after the import
it must assert SamaPrime's scanner is STOPPED, because the sets are then
identical by design. *The same script cannot serve both regimes and must not be
left claiming it does.*

### WHAT THE REHEARSAL MUST COVER, BECAUSE HE ASKED FOR ROLLBACK PROVEN FIRST

Against `samapay_sandbox` and a restorable copy of SamaPrime's schema:

    · copy blob + key, assert SamaPay derives the SAME 194 addresses as
      SamaPrime holds — that is the real proof the move worked, and it is
      an equality between two independent derivations
    · cut, assert SamaPrime REFUSES to derive
    · roll back, assert SamaPrime derives again AND the addresses still match
    ⚠️ assert the rollback restored ALL THREE properties, not two — this repo
      has a recorded revert that restored indexes and nullability and silently
      skipped a foreign key

### OPEN, AND HIS

- **`02e0fb61`**: retired-and-deleted, or kept dormant? It has no job under #27.
- **Whether the August paper still exists.** Everything else in this plan is
  recoverable; that is not.
