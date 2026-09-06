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

