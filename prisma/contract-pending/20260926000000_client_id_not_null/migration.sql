-- CONTRACT step for Phase 0's client_id (contract v1.1 A12) — NOT PART OF
-- THE PHASE 0 APPLY. Lives in prisma/contract-pending/, OUTSIDE
-- prisma/migrations, so `prisma migrate deploy` cannot pick it up early.
--
-- APPLY ONLY AFTER: (1) 20260925000000_phase0 is applied, (2) the Phase 0
-- code (every insert into addresses / deposits / webhook_deliveries writes
-- client_id) is DEPLOYED and restarted, (3) this read-only query returns 0:
--   SELECT (SELECT count(*) FROM addresses WHERE client_id IS NULL)
--        + (SELECT count(*) FROM deposits WHERE client_id IS NULL)
--        + (SELECT count(*) FROM webhook_deliveries WHERE client_id IS NULL);
--   (non-zero = rows written by the old build in the deploy window: re-run
--   the three backfill UPDATEs from 20260925000000_phase0, then re-check.)
-- HOW: in ONE commit, move this directory into prisma/migrations/ AND change
-- `clientId String?` / `client Client?` to `String` / `Client` on Address,
-- Deposit and WebhookDelivery in schema.prisma; prove with
-- throwaway-sandbox.ts --check-migrations; then `migrate deploy`.
--
-- GENERATED FILE-TO-FILE: prisma migrate diff
--   --from-schema-datamodel prisma/schema.prisma (Phase 0, client_id nullable)
--   --to-schema-datamodel <same with the three client_id NOT NULL> --script
-- Three statements, all SET NOT NULL; nothing dropped. Each fails (and
-- changes nothing for its table) if a NULL remains.

-- AlterTable
ALTER TABLE "addresses" ALTER COLUMN "client_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "deposits" ALTER COLUMN "client_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "webhook_deliveries" ALTER COLUMN "client_id" SET NOT NULL;

