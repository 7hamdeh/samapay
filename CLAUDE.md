# SamaPay — CLAUDE.md

SamaPay is a SEPARATE service: own repo, own database, own PM2 process,
own domain. It owns all crypto. SamaPrime is its first HTTP client with
no privileged path; every merchant is a client with its own key; dahabi
is the second client. Not a public gateway: keys are issued by Ibrahim's
hand or by a SamaPrime admin action only.

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
