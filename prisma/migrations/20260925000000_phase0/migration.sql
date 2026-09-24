-- Phase 0 (pay.mntad.com) — THE ONE G6 MIGRATION: client terms, per-deposit
-- merchant fee, address watch switch, legacy-watch stamp, events table.
-- GENERATED FILE-TO-FILE: prisma migrate diff
--   --from-schema-datamodel <prisma/schema.prisma at 1ae7f3c>
--   --to-schema-datamodel prisma/schema.prisma --script
-- Never against a database. Every statement below was read. Proven by
-- scripts/throwaway-sandbox.ts --check-migrations (migrations replayed into
-- a throwaway shadow DB reproduce schema.prisma exactly: diff exit 0).
--
-- PURELY ADDITIVE: no DROP, no ALTER/RENAME of an existing column, no ADD
-- VALUE to an existing enum. Every new NOT NULL column has a constant
-- DEFAULT, so existing rows are filled without a rewrite of meaning:
--   clients.fee_bps = 0, min_intent = 1, max_intent = 10000,
--   enabled_chains = {BEP20,TRC20}; deposits.fee_amount = 0 (no fee was
--   ever charged before this migration).
-- ORDER: after 20260907000000_scan_gaps and 20260924000000_payment_intents
-- (both unapplied in production as of 2026-09-24; migrate deploy applies all
-- three in name order).
--
-- FIELD LIST
--   clients.fee_bps            INTEGER NOT NULL DEFAULT 0      merchant fee, basis points 0..10000 (range: Zod in src/keys/terms.ts)
--   clients.min_intent         DECIMAL(18,6) NOT NULL DEFAULT 1
--   clients.max_intent         DECIMAL(18,6) NOT NULL DEFAULT 10000
--   clients.enabled_chains     "Chain"[] DEFAULT {BEP20,TRC20}  (Prisma scalar lists carry no NOT NULL)
--   addresses.watch_disabled_at   TIMESTAMP(3) NULL  set by scripts/ops/disable-address.ts; observer skips (contract §9 step 0)
--   deposits.fee_amount        DECIMAL(18,6) NOT NULL DEFAULT 0  stamped at confirmation by the observer (src/allowance/fee.ts)
--   scan_cursors.legacy_watch_enabled_at  TIMESTAMP(3) NULL  set with the cursor by start-legacy-watch (§9 step 5b)
--   events: id TEXT PK (evt_…), client_id FK clients, key_id FK client_keys,
--           type TEXT, object_kind "EventObjectKind" (payment_intent|deposit),
--           object_id TEXT, api_version TEXT DEFAULT '2026-09-24',
--           snapshot JSONB, created_at TIMESTAMP(3) DEFAULT now;
--           UNIQUE(object_id, type) — at most one event per (object, type);
--           INDEX(client_id, created_at).
-- Timestamps are TIMESTAMP(3) (UTC by Prisma) like every other column in this
-- database — deliberately not timestamptz (one mixed column is how a
-- with/without-time-zone comparison invents an offset-sized gap).
-- payment_intent_events (from 20260924000000) is SUPERSEDED by events and is
-- left in place untouched; a later CONTRACT migration drops it.

-- CreateEnum
CREATE TYPE "EventObjectKind" AS ENUM ('payment_intent', 'deposit');

-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "enabled_chains" "Chain"[] DEFAULT ARRAY['BEP20', 'TRC20']::"Chain"[],
ADD COLUMN     "fee_bps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "max_intent" DECIMAL(18,6) NOT NULL DEFAULT 10000,
ADD COLUMN     "min_intent" DECIMAL(18,6) NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "addresses" ADD COLUMN     "watch_disabled_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "deposits" ADD COLUMN     "fee_amount" DECIMAL(18,6) NOT NULL DEFAULT 0;

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

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "client_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

