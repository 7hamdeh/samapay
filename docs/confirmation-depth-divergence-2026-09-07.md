# TWO DEFINITIONS OF ONE MONEY-PATH QUANTITY — THE OBSERVER IGNORES THE CONFIGURED CONFIRMATION DEPTH

**2026-09-07, providers-rules. Filed OPEN. Latent, not live — measured, see
§3. NOT fixed then: it was found while executing Ibrahim's four approved
steps for the TRC20 rewind, and a fifth change riding in under an approval
for four is the exact defect that night was about.**

⚠️ **CLOSED 2026-09-10, `samaprime-com-64` (SamaPay), commit `0eaabcd`.**
Taken as item 3 of that day's status report, per lead's instruction to close
it before either `CRYPTO_TRON_CONFIRMATIONS` or `CRYPTO_BSC_CONFIRMATIONS` is
ever set, not after. The duplicate was REMOVED rather than reconciled with an
equality assertion: `chain/live.ts`'s scan-window cap and
`observer/index.ts`'s crediting threshold both now read
`getChainConfig(chain).confirmationsRequired` (an explicit parameter into
`observeChain`, not a module constant either module keeps its own copy of).
Proven by `scripts/verify-confirmation-depth-single-source.ts` — 9/0,
including a real seed-the-defect-and-watch-it-fail run before this fix was
trusted. The scope measured in §3 below (harmless while both env vars are
unset) held at the moment of the fix and is no longer load-bearing: it is
now correct regardless of whether either variable is ever set.

**The section below is kept verbatim as the original finding — do not edit
it to read as already fixed.**

## 1. THE TWO SITES

    src/chain/types.ts:24         CONFIRMATIONS_REQUIRED      { BEP20: 15, TRC20: 19 }
                                  *** THE OBSERVER CREDITS ON THIS ***
                                  src/observer/index.ts, promoteConfirmed()

    src/chain/impl/config.ts:97   MAINNET_CONFIRMATION_FLOOR  { BEP20: 15, TRC20: 19 }
                                  a FLOOR under an env-overridable value:
                                  confirmationsRequired = testnet ? 3
                                    : mainnetConfirmations(chain, "CRYPTO_TRON_CONFIRMATIONS")

## 2. WHY IT IS A DEFECT AND NOT A DUPLICATE

`confirmationsRequired` is what the ADAPTER is configured with.
`CONFIRMATIONS_REQUIRED` is what the OBSERVER credits on. **Nothing reads
both, and nothing compares them.**

    CRYPTO_TRON_CONFIRMATIONS=25   -> adapter honours 25
                                   -> observer still credits at 19
                                   *** MONEY BECOMES SPENDABLE EARLIER THAN
                                       CONFIGURED, AND NOTHING GOES RED ***

    CRYPTO_MODE=testnet            -> adapter says 3, observer waits 19
                                      (harmless direction, same divergence)

⚠️ **THIS IS THE "CONFIG EDIT THAT LOOKS APPLIED AND CHANGES NOTHING" SHAPE,
ON A REORG-SAFETY PARAMETER.** An operator raising the depth after a scare
would read the setting as applied. It would be applied — to the half that
does not decide when the credit happens.

## 3. SCOPE OF THE "LATENT" CLAIM — MEASURED 2026-09-07 03:5x

    CRYPTO_MODE=mainnet
    CRYPTO_TRON_CONFIRMATIONS   not set
    CRYPTO_BSC_CONFIRMATIONS    not set
    => both read 19 / 15 today; the two agree; nothing is mispriced now.

**It becomes live the moment anyone sets either variable, or runs testnet.**

## 4. THE FIX, WHEN IT IS SCHEDULED

One quantity, one reader: **the observer should credit on the ADAPTER's
`confirmationsRequired`**, not on its own constant — the adapter is the
thing that was configured. `CONFIRMATIONS_REQUIRED` then becomes the floor
it already is in `config.ts`, and the scan-window cap in `chain/live.ts`
(commit 0d717dc) must move to the same source in the same change, or the
scanner and the crediting rule drift the other way.

⚠️ **AND THE ASSERTION THAT WOULD CATCH IT IS NOT A LITERAL:** assert the
two INDEPENDENT paths agree — `getChainAdapter(c).confirmationsRequired ===
<what the observer credits on>` — because an equality between two paths
cannot be satisfied by one wrong mental model.

## 5. HOW IT WAS FOUND, WHICH IS THE PART WORTH KEEPING

A control I printed said `(one definition only — control)` — **hardcoded
text, authored before the measurement** — while the `grep` on the same line
returned TWO paths. ***A LABEL WRITTEN BEFORE THE NUMBER IS A CONCLUSION
WEARING A VARIABLE NAME.*** The grep is what caught it; my own sentence
would have carried the opposite claim into the report.
