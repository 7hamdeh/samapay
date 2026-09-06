-- CreateTable
CREATE TABLE "crypto_config" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "encrypted_master_seed" TEXT NOT NULL,
    "seed_fingerprint" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vault_verifier" TEXT,
    "hot_wallet_address_bep20" TEXT,
    "hot_wallet_address_trc20" TEXT,

    CONSTRAINT "crypto_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan_cursors" (
    "chain" "Chain" NOT NULL,
    "last_scanned_block" BIGINT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scan_cursors_pkey" PRIMARY KEY ("chain")
);

