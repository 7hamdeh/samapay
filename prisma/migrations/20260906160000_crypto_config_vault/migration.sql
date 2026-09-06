-- CreateTable
CREATE TABLE "crypto_config" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "encrypted_master_seed" TEXT NOT NULL,
    "seed_fingerprint" TEXT NOT NULL,
    "vault_ciphertext" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crypto_config_pkey" PRIMARY KEY ("id")
);

