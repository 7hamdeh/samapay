-- Phase 0 (pay.mntad.com) — THE G6 MIGRATION (EXPAND step): client terms,
-- per-deposit merchant fee, address watch switch, legacy-watch stamp, events
-- table, client_id ownership columns (NULLABLE), the A7 uniqueness indexes.
--
-- GENERATED FILE-TO-FILE: prisma migrate diff
--   --from-schema-datamodel <prisma/schema.prisma at 1ae7f3c>
--   --to-schema-datamodel prisma/schema.prisma --script
-- Never against a database. Every statement below was read.
-- HAND-ADDED (data only, no schema object; marked "HAND-ADDED" in place):
--   (1) the PRE-CHECK block at the top, (2) three client_id BACKFILL
--   UPDATEs, (3) the POST-BACKFILL CHECK block. Everything else is the
--   generator's output verbatim. Proven by scripts/throwaway-sandbox.ts
--   --check-migrations (all migration files replayed into a throwaway shadow
--   DB reproduce schema.prisma exactly: diff exit 0).
--
-- EXPAND → DEPLOY → CONTRACT (contract v1.1 A12): client_id is added
-- NULLABLE here so the build running between `migrate deploy` and the code
-- deploy can still insert rows without it. The NOT NULL is the SEPARATE file
-- prisma/contract-pending/20260926000000_client_id_not_null/migration.sql —
-- deliberately OUTSIDE prisma/migrations so `migrate deploy` cannot apply it
-- early. It moves into prisma/migrations only after the new code (which
-- always writes client_id) is deployed; see that file's header.
-- UNIQUE(client_id, chain, reference) on addresses is created HERE, after
-- the backfill: every existing row has a client_id by then, and a NULL
-- client_id (a row inserted by the old build in the deploy window) never
-- collides in a Postgres unique index.
--
-- DESTRUCTIVE STATEMENTS: exactly one — DROP INDEX
-- "payment_intents_client_id_reference_idx" (a plain index from
-- 20260924000000, replaced in the same file by the UNIQUE index on the same
-- two columns). No table, column or data is dropped. No ALTER TYPE … ADD VALUE.
--
-- WHAT CAN FAIL, AND WHEN: the three new UNIQUE indexes fail on existing
-- duplicates. The PRE-CHECK below raises FIRST, before any statement has
-- changed anything, naming the duplicate set. Read-only query for Ibrahim to
-- run beforehand (production, SELECT only):
--   SELECT k.client_id, a.chain, a.reference, count(*) FROM addresses a
--     JOIN client_keys k ON k.id = a.key_id GROUP BY 1,2,3 HAVING count(*) > 1;
--   SELECT key_id, event_id, count(*) FROM webhook_deliveries GROUP BY 1,2 HAVING count(*) > 1;
--
-- TIMESTAMPS: every new timestamp column is TIMESTAMP(3) WITHOUT TIME ZONE,
-- like every other in this database, and holds UTC. EVERY WRITE MUST BE A
-- PRISMA Date (serialized as UTC) OR AN EXPLICIT UTC EXPRESSION
-- (now() AT TIME ZONE 'utc') — NEVER a bare NOW()/CURRENT_TIMESTAMP in raw
-- SQL: cast to "without time zone" that yields the SESSION's local time
-- (MNTAD once wrote Berlin time exactly that way). The generated
-- `events.created_at DEFAULT CURRENT_TIMESTAMP` is Prisma's standard
-- @default(now()) rendering, the same as every existing created_at here;
-- code must still pass created_at explicitly or rely on Prisma, never on a
-- raw INSERT that omits it.
--
-- ORDER: after 20260907000000_scan_gaps and 20260924000000_payment_intents
-- (both unapplied in production as of 2026-09-24; migrate deploy applies
-- all three in name order).
--
-- FIELD LIST
--   clients.fee_bps              INTEGER NOT NULL DEFAULT 0   merchant fee, bps 0..10000 (range: Zod, src/keys/terms.ts)
--   clients.min_intent           DECIMAL(18,6) NOT NULL DEFAULT 1
--   clients.max_intent           DECIMAL(18,6) NOT NULL DEFAULT 10000
--   clients.enabled_chains       "Chain"[] DEFAULT {BEP20,TRC20}   (Prisma scalar lists carry no NOT NULL)
--   addresses.client_id          TEXT NULL, FK clients           backfilled from client_keys; NOT NULL in contract-pending
--   addresses.watch_disabled_at  TIMESTAMP(3) NULL               scripts/ops/disable-address.ts; observer skips (§9 step 0)
--   deposits.client_id           TEXT NULL, FK clients           backfilled; NOT NULL in contract-pending
--   deposits.fee_amount          DECIMAL(18,6) NOT NULL DEFAULT 0 stamped at confirmation (src/allowance/fee.ts)
--   webhook_deliveries.client_id TEXT NULL, FK clients           backfilled; NOT NULL in contract-pending
--   scan_cursors.legacy_watch_enabled_at TIMESTAMP(3) NULL       THE single legacy-handover switch (§9 step 5b, A3)
--   events: id TEXT PK (evt_…), client_id FK clients, key_id FK client_keys,
--           type TEXT, object_kind "EventObjectKind" (payment_intent|deposit),
--           object_id TEXT, api_version TEXT DEFAULT '2026-09-24',
--           snapshot JSONB, created_at TIMESTAMP(3);
--           UNIQUE(object_id, type); INDEX(client_id, created_at)
--   UNIQUE addresses(client_id, chain, reference)                A7
--   UNIQUE payment_intents(client_id, reference)                 A7 (replaces the plain index)
--   UNIQUE webhook_deliveries(key_id, event_id)                  G3: structural enqueue idempotency
-- payment_intent_events (from 20260924000000) is SUPERSEDED by events and is
-- left untouched; a later CONTRACT migration drops it.

-- HAND-ADDED PRE-CHECK (reads only; raises before anything is changed)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "addresses" a JOIN "client_keys" k ON k."id" = a."key_id"
             GROUP BY k."client_id", a."chain", a."reference" HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'phase0 pre-check: addresses has duplicate (client, chain, reference) rows; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM "webhook_deliveries" GROUP BY "key_id", "event_id" HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'phase0 pre-check: webhook_deliveries has duplicate (key_id, event_id) rows; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM "payment_intents" GROUP BY "client_id", "reference" HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'phase0 pre-check: payment_intents has duplicate (client_id, reference) rows; nothing was changed';
  END IF;
END $$;

-- CreateEnum
CREATE TYPE "EventObjectKind" AS ENUM ('payment_intent', 'deposit');

-- DropIndex
DROP INDEX "payment_intents_client_id_reference_idx";

-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "enabled_chains" "Chain"[] DEFAULT ARRAY['BEP20', 'TRC20']::"Chain"[],
ADD COLUMN     "fee_bps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "max_intent" DECIMAL(18,6) NOT NULL DEFAULT 10000,
ADD COLUMN     "min_intent" DECIMAL(18,6) NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "addresses" ADD COLUMN     "client_id" TEXT,
ADD COLUMN     "watch_disabled_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "deposits" ADD COLUMN     "client_id" TEXT,
ADD COLUMN     "fee_amount" DECIMAL(18,6) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "webhook_deliveries" ADD COLUMN     "client_id" TEXT;

-- HAND-ADDED BACKFILL: client_id from the row's key (client_keys.client_id is NOT NULL + FK)
UPDATE "addresses" a SET "client_id" = k."client_id" FROM "client_keys" k WHERE k."id" = a."key_id" AND a."client_id" IS NULL;

-- HAND-ADDED BACKFILL
UPDATE "deposits" d SET "client_id" = k."client_id" FROM "client_keys" k WHERE k."id" = d."key_id" AND d."client_id" IS NULL;

-- HAND-ADDED BACKFILL
UPDATE "webhook_deliveries" w SET "client_id" = k."client_id" FROM "client_keys" k WHERE k."id" = w."key_id" AND w."client_id" IS NULL;

-- HAND-ADDED POST-BACKFILL CHECK: no existing row is left without a client_id
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "addresses" WHERE "client_id" IS NULL)
     OR EXISTS (SELECT 1 FROM "deposits" WHERE "client_id" IS NULL)
     OR EXISTS (SELECT 1 FROM "webhook_deliveries" WHERE "client_id" IS NULL) THEN
    RAISE EXCEPTION 'phase0 backfill: a row still has client_id NULL';
  END IF;
END $$;

-- AlterTable
ALTER TABLE "scan_cursors" ADD COLUMN     "legacy_watch_enabled_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "object_kind" "EventObjectKind" NOT NULL,
    "object_id" TEXT NOT NULL,
    "api_version" TEXT NOT NULL DEFAULT '2026-09-24',
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "events_client_id_created_at_idx" ON "events"("client_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "events_object_id_type_key" ON "events"("object_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "addresses_client_id_chain_reference_key" ON "addresses"("client_id", "chain", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_key_id_event_id_key" ON "webhook_deliveries"("key_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_client_id_reference_key" ON "payment_intents"("client_id", "reference");

-- AddForeignKey
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "client_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

