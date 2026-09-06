# SamaPay — CLAUDE.md

SamaPay is a SEPARATE service: own repo, own database, own PM2 process,
own domain. It owns all crypto. SamaPrime is its first HTTP client with
no privileged path; every merchant is a client with its own key; dahabi
is the second client.

**KEYS — IBRAHIM'S RULE, TYPED BY HIS HAND 2026-09-06, VERBATIM:**
> "KEYS ARE MINTED BY THE OWNER'S HAND OR BY THE CLIENT PANEL'S OWN
> SIGNED-IN OWNER FOR THEIR OWN ACCOUNT — NEVER BY AN OPERATOR ON SOMEONE
> ELSE'S BEHALF."

Read what moved: the old sentence named WHO may act; this one names WHOSE
ACCOUNT may be acted on, and the last clause is the rule. "A SamaPrime
admin action" is no longer a minting path, and a support flow where an
operator mints a key to help a stuck client is forbidden by name. The
panel survey (`docs/panel-survey-2026-09-06.md` §5 refusal 13, §6 S4)
carries it into code as a refusal with its own assertion.

~~Not a public gateway: keys are issued by Ibrahim's hand or by a SamaPrime
admin action only.~~ *(Struck 2026-09-06, superseded by the rule above. It
was true from 2026-09-04 until the client-panel goal of 2026-09-06 made a
self-service minting path legitimate; the survey's reconciliation row 2
cites the struck wording as it stood.)*

SPEC: `docs/scratch/samapay-api-v1-draft-2026-09-04.md` in the SamaPrime
repo (v1.1) and value-model's allowance spec. THE ONE RULE: a key may
withdraw at most what arrived on-chain at addresses issued to that key;
manual deposits do not exist in this service.

The SamaPrime repository's CLAUDE.md rules apply here in full — the four
classes Ibrahim signs (migrations, money movement, customer-visible money
path, rule changes), the enumeration rule, red-first tests, MEASURED vs
INFERRED, stated scopes on negative claims, reports to the coordinator.
Read it before working here.

Conventions: Hono over Web Request/Response, Prisma via `src/db/client.ts`
only, every verify script begins with `assertSandboxDatabase()`
(`src/db/guard.ts`), `pnpm verify:sandbox scripts/verify-x.ts`, counted
leftovers. `src/observer/` is the only writer of `deposits`.
