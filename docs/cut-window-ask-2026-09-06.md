# THE CUT WINDOW — THE ASK, 2026-09-06

**providers-rules. Everything below was RUN by me this morning unless a line
says RELAYED. Builds on `docs/cut-window-2026-09-05.md` (the plan) and
SamaPrime's decision register entries #9 and #10.**

---

## ══ FOR IBRAHIM ══

### 1. THE WINDOW CANNOT RUN TODAY, AND THIS IS THE WHOLE ANSWER

The plan hands the deposit path from SamaPrime to SamaPay. **SamaPay cannot
do chain work at all yet.** Measured this morning, in the SamaPay code:

    the three chain functions           ALL REFUSE, by design, with the
    (make an address, watch the chain,  message "chain layer not wired (step 4)"
     send money out)
    the libraries that talk to the      NOT INSTALLED — none of them
    blockchains

The control passed: another library the service really does use is present,
so this is a measurement and not a broken check.

**Two steps of the window need exactly those functions** — starting the
watcher and proving a new deposit address works. **Both would refuse.**

⇒ **If we ran the window today, deposits would stop working and would not
start again on the other side.** Not "degraded for 25 minutes" — off, until
the missing piece is built. **That is the opposite of what the window is
for.**

**What is missing is one known piece of work**, already named as step 4 and
deliberately left until last: roughly 29 files of existing, working
SamaPrime chain code moved across, plus installing the libraries. **It is
not new invention.** Nobody has started it.

### 2. TWO THINGS I NEED YOU TO DECIDE, AND I WILL NOT GUESS EITHER

**DECISION A — how wide is the maintenance page?**

You ruled that a flag file switches nginx to serve a maintenance page
**"for every path"**, with the app bypassed entirely. **My plan says the
opposite**, in as many words: a site-wide page would be *"over-broad by a
factor of the whole product"*, because only the deposit page is actually
affected — the store, orders, SMS, transfers, sign-in and every storefront
keep working normally.

**Both are defensible and they are not compatible. Pick one:**

- **(أ) NARROW** — the 503 covers only the deposit page and its three
  routes. Everything else stays live. *My plan's ~25 minutes and its "only
  1.7% chance a deposit lands inside the window" both rest on this.*
- **(ب) WHOLE SITE** — the 503 covers everything, the entire platform is
  down for the window. *This retires that part of my plan and the
  arithmetic with it, and I will rewrite both.*

**DECISION B — do you still want to sign today?**

Given item 1, a signature today would be a signature on something that
cannot be executed today. **I am not asking you to abandon it — I am asking
whether you want to (i) schedule the missing piece first and sign the window
after it lands, or (ii) sign the window now with an explicit condition that
it only runs once that piece is proven.**

### 3. ONE THING THAT ALREADY CONTRADICTS WHAT YOU TYPED

You said the maintenance page must be served **by nginx while the app is
down**. Measured:

    nginx does not know about the page at all — zero references,
    both in the config files and in what nginx has actually loaded
    the page IS reachable right now, at its own address, while the
    site is up and healthy

⇒ **The page exists and nothing serves it.** Today it is a file that
answers only while the app is running — which is precisely the version you
said means nothing. **Building the nginx half is part of the window work and
is not done.** I am telling you now rather than after you sign.

### 4. AND A NAMING TRAP THAT WOULD MAKE ROLLBACK LIE

**Two different switches are both called "the flag" right now.** One is a
setting inside SamaPrime that turns the deposit feature on and off. The
other is the file on disk that turns the nginx maintenance page on.

**My rollback flips the first.** If the window were opened with the second,
**rollback would report success while the whole site stayed dark.** Nobody
would connect the two. **They get different names before either is built** —
that costs nothing today and is very expensive to discover at 3am.

---

## ══ FOR THE ADVISOR ══

### MEASUREMENTS, ALL RUN 2026-09-06, WITH CONTROLS

**1. SamaPay chain capability — MEASURED, `/www/wwwroot/samapay`:**

    src/chain/            registry.ts, types.ts only
    registry.ts:15-20     ChainUnavailable("chain layer not wired: …(step 4)")
                          refusingDeriver.deriveNext / refusingObserver.scan
                          / refusingObserver.confirmationsFor / refusingSender.send
    node_modules          ethers ABSENT · tronweb ABSENT · web3 ABSENT
                          · @tronweb3/... ABSENT
    CONTROL               hono present  ⇒ the probe can see an installed package

**2. Window steps that require it — `docs/cut-window-2026-09-05.md`:**

    line 171   "6. Start SamaPay's observer; prove it sees the same chain head"
    line 174   "8. ARRIVAL CHECK — issue an address through SamaPrime, read …"

Both call functions that throw `ChainUnavailable` today. ⇒ the window is
**blocked**, not merely risky. INFERRED from reading the steps against the
stubs; the falsifying test is running step 6 and observing whether it throws.

**3. The scope contradiction — both quoted at source:**

    #9  (register, origin/main 6ccf132)
        "503 + Retry-After for every path when a flag file exists,
         bypassing the app entirely"
    plan lines 38-42
        "A SITE-WIDE MAINTENANCE PAGE WOULD BE OVER-BROAD BY A FACTOR OF
         THE WHOLE PRODUCT — gate the deposit page and its three routes,
         nothing else"
    plan term counts over 204 lines: "503" 0 · "app-down" 0 · "nginx" 1

**NOT RESOLVED BY ME, DELIBERATELY.** It is a product-scope decision, it
changes the duration and the risk arithmetic, and guessing it would be
inventing scope. It is Decision A above.

**4. The nginx half — MEASURED with three controls:**

    vhost files matching "maintenance"        0
    nginx -T          matching "maintenance"  0
    CONTROL  nginx -T  client_max_body_size   6
    CONTROL  vhost files matching "samaprime" 8
    ABSENT-CONTROL    "zzq-no-such-directive" 0

**5. The page is fetchable while the app is up:**

    GET /maintenance/index.html   200
    ⚠️ CONTROL CAVEAT, STATED: a known-absent path returned 307, not 404 —
    the origin redirects unknown paths. So the 308/307 on the bare
    /maintenance paths prove nothing; only the 200 on the literal file is
    a finding.

### THE PLAN'S OWN SCOPE, RESTATED SO IT IS NOT LOST

`docs/cut-window-2026-09-05.md` §6 already lists what it did NOT measure,
including whether the observer's first scan reconciles exactly. **That gap
is now dominated by item 1: there is no observer to reconcile.**

### WHAT I DID NOT DO

- Did not build the nginx rule. It changes what the live server serves.
- Did not rename either flag. Naming is cheap; doing it inside someone
  else's in-flight work is not.
- Did not resolve #9 vs the plan. See above.
