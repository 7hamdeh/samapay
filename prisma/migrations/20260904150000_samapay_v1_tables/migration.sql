-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ClientKind" AS ENUM ('platform', 'partner');

-- CreateEnum
CREATE TYPE "KeyEnvironment" AS ENUM ('live', 'test');

-- CreateEnum
CREATE TYPE "Chain" AS ENUM ('BEP20', 'TRC20');

-- CreateEnum
CREATE TYPE "DepositStatus" AS ENUM ('detected', 'confirmed', 'orphaned');

-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('pending', 'sending', 'sent', 'confirmed', 'cancelled', 'expired', 'send_unknown', 'failed', 'refunded', 'rejected');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('held', 'released', 'expired');

-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('processing', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('pending', 'delivered', 'failed', 'exhausted');

-- CreateTable
CREATE TABLE "clients" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ClientKind" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_keys" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "key_last4" TEXT NOT NULL,
    "scopes" TEXT[],
    "environment" "KeyEnvironment" NOT NULL DEFAULT 'live',
    "rps_limit" INTEGER NOT NULL DEFAULT 10,
    "monthly_limit" INTEGER NOT NULL DEFAULT 100000,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_used_at" TIMESTAMP(3),
    "last_used_ip" TEXT,
    "issued_by" TEXT NOT NULL,
    "issued_via" TEXT NOT NULL,
    "successor_key_id" TEXT,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" TEXT,
    "webhook_url" TEXT,
    "webhook_secret" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "addresses" (
    "id" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "address" TEXT NOT NULL,
    "derivation_index" INTEGER NOT NULL,
    "legacy_import" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposits" (
    "id" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "address_id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "amount" DECIMAL(18,6) NOT NULL,
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "status" "DepositStatus" NOT NULL DEFAULT 'detected',
    "block_number" BIGINT,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "credited_at" TIMESTAMP(3),

    CONSTRAINT "deposits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawals" (
    "id" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "reference" TEXT,
    "to_address" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "amount" DECIMAL(18,6) NOT NULL,
    "fee" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'pending',
    "idempotency_key" TEXT NOT NULL,
    "tx_hash" TEXT,
    "evidence" JSONB,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservations" (
    "id" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "withdrawal_id" TEXT NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'held',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMP(3),
    "reason" TEXT,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "idem_key" TEXT NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "status" "IdempotencyStatus" NOT NULL DEFAULT 'processing',
    "status_code" INTEGER,
    "response_body" JSONB,
    "locked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'pending',
    "next_attempt_at" TIMESTAMP(3),
    "last_status_code" INTEGER,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "key_id" TEXT,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "subject_id" TEXT,
    "idempotency_key" TEXT,
    "params" JSONB,
    "prev_hash" CHAR(64) NOT NULL,
    "hash" CHAR(64) NOT NULL,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "client_keys_key_prefix_key" ON "client_keys"("key_prefix");

-- CreateIndex
CREATE INDEX "client_keys_client_id_active_idx" ON "client_keys"("client_id", "active");

-- CreateIndex
CREATE INDEX "addresses_key_id_reference_idx" ON "addresses"("key_id", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "addresses_chain_address_key" ON "addresses"("chain", "address");

-- CreateIndex
CREATE UNIQUE INDEX "addresses_chain_derivation_index_key" ON "addresses"("chain", "derivation_index");

-- CreateIndex
CREATE INDEX "deposits_key_id_status_idx" ON "deposits"("key_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "deposits_chain_tx_hash_key" ON "deposits"("chain", "tx_hash");

-- CreateIndex
CREATE INDEX "withdrawals_key_id_status_idx" ON "withdrawals"("key_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "withdrawals_key_id_idempotency_key_key" ON "withdrawals"("key_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_withdrawal_id_key" ON "reservations"("withdrawal_id");

-- CreateIndex
CREATE INDEX "reservations_key_id_status_idx" ON "reservations"("key_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_key_id_idem_key_key" ON "idempotency_keys"("key_id", "idem_key");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_next_attempt_at_idx" ON "webhook_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "audit_events_hash_key" ON "audit_events"("hash");

-- CreateIndex
CREATE INDEX "audit_events_key_id_at_idx" ON "audit_events"("key_id", "at");

-- AddForeignKey
ALTER TABLE "client_keys" ADD CONSTRAINT "client_keys_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "client_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "client_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "addresses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "client_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "client_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_withdrawal_id_fkey" FOREIGN KEY ("withdrawal_id") REFERENCES "withdrawals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "client_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "client_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "client_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- =====================================================================
-- HAND-WRITTEN, IN THE SCHEMA'S OWN WORDS: audit_events IS APPEND-ONLY.
-- =====================================================================
-- Copied as a CONTRACT from SamaPrime's 20260826193605 / 20260827010000
-- migrations (the audit chain there carries seven permanent scars from
-- rows deleted before this trigger existed). Here it exists from row one.
CREATE OR REPLACE FUNCTION audit_events_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is immutable in place: row % cannot be modified', OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_events_immutable BEFORE UPDATE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION audit_events_no_update();

CREATE OR REPLACE FUNCTION audit_events_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: deleting row % would break the hash chain permanently', OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION audit_events_no_delete();
