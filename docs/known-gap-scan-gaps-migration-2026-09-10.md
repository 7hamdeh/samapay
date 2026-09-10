# ACCEPTED KNOWN GAP — `scan_gaps` MIGRATION UNAPPLIED, GAP-DIAGNOSIS CODE ABSENT

**Filed 2026-09-10, samaprime-com-64 (SamaPay owner). Per CLAUDE.md's own
rule: "if you cannot name an owner and a date, it does not belong here —
fix the check or delete it." This entry names both.**

## WHAT IS ACCEPTED, PRECISELY

Two things, and neither is live risk today — MEASURED, not assumed:

    prisma/migrations/20260907000000_scan_gaps/   ON DISK, in schema.prisma,
                                                   NOT in _prisma_migrations
                                                   (only 2 migrations show
                                                   finished_at: v1_tables,
                                                   crypto_config_vault)
    psql: select count(*) from scan_gaps;         relation does not exist
    grep -rn "scan_gaps\|ScanGap\|closeCoveredGaps\|recordGap" src/
                                                   ZERO hits

**So: the table was never created in production, and the code that would
write to it (`closeCoveredGaps` / `recordGap`, described in commit
`4cf6b99`'s message) is not in the current source tree at all — it was
either reverted or never landed past that commit's description.** Neither
half exists, so neither can fail. This is exactly TRAP 21's subject: *"has
no subject in the running code today, filed anyway because the person who
will need it is not in this conversation."*

## WHY IT IS SAFE TO LEAVE OPEN RIGHT NOW

Nothing calls a table that does not exist, so there is no crash path. The
cost is diagnostic, not correctness: if TronGrid or a BSC endpoint hiccups
and the scanner skips blocks, there is currently no record distinguishing
"a deposit was missed in a gap" from "a deposit never arrived" — the same
ambiguity `docs/scratch/` already paid for once in SamaPrime (947 blocks
on a TronGrid 429, 13,319 on a triple BSC rate-limit).

## THE INSTRUCTION FOR WHOEVER RE-ADDS IT

Per TRAP 21, already written down before this entry existed:

1. Land the migration and the writing code in the SAME commit — never the
   table first with code following later, and never code that could write
   before the table exists in production.
2. Do NOT accept a clean run as evidence the close path works. Force a
   real gap in sandbox (a throwaway range, a deliberately-skipped chunk)
   and watch `closeCoveredGaps()` actually execute and clear the row.
3. Check the table exists in the DATABASE the running process talks to,
   not only that `prisma migrate status` reports it pending/applied —
   this repo has a standing rule about the two disagreeing.

## OWNER AND REVIEW DATE

    owner      samaprime-com-64 (SamaPay)
    reviewBy   2026-09-17 — re-open this file that day: either the gap
               table + writing code have landed together and been proven
               with a forced gap, or this acceptance is renewed with a new
               date and a reason, per the same rule.

**Not picked up this cycle** — item 3 (confirmation-depth divergence) is
CLOSED same cycle (commit `0eaabcd`, see
`docs/confirmation-depth-divergence-2026-09-07.md`'s closure note); the
seed-move rehearsal is ahead of this item in the queue, per lead's
instruction 2026-09-10.
