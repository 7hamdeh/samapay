-- S2 slice 1 — payment intents + the `merchant` client kind (decision #80).
-- GENERATED FILE-TO-FILE: prisma migrate diff --from-schema-datamodel <schema.prisma at c6b7e45>
--   --to-schema-datamodel prisma/schema.prisma --script. Never against a database.
-- Purely additive: no DROP, no ALTER of an existing column. ADD VALUE is not
-- used by any statement in this file (PostgreSQL forbids using a new enum
-- value in the transaction that adds it).
-- ORDER: 20260907000000_scan_gaps (unapplied in production as of 2026-09-23)
-- sorts before this one and is applied first by migrate deploy.

-- CreateEnum
CREATE TYPE "PaymentIntentStatus" AS ENUM ('requires_payment', 'processing', 'succeeded', 'succeeded_late', 'expired', 'expired_partial');

-- AlterEnum
ALTER TYPE "ClientKind" ADD VALUE 'merchant';

-- CreateTable
CREATE TABLE "payment_intents" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "address_id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "amount" DECIMAL(18,6) NOT NULL,
    "reference" TEXT NOT NULL,
    "status" "PaymentIntentStatus" NOT NULL DEFAULT 'requires_payment',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "succeeded_at" TIMESTAMP(3),
    "expired_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_intent_events" (
    "id" TEXT NOT NULL,
    "intent_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_intent_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_address_id_key" ON "payment_intents"("address_id");

-- CreateIndex
CREATE INDEX "payment_intents_client_id_reference_idx" ON "payment_intents"("client_id", "reference");

-- CreateIndex
CREATE INDEX "payment_intents_status_expires_at_idx" ON "payment_intents"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_intent_events_intent_id_type_key" ON "payment_intent_events"("intent_id", "type");

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "client_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "addresses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_intent_events" ADD CONSTRAINT "payment_intent_events_intent_id_fkey" FOREIGN KEY ("intent_id") REFERENCES "payment_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

