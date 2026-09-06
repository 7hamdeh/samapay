-- CreateTable
CREATE TABLE "scan_gaps" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "from_block" BIGINT NOT NULL,
    "to_block" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" TEXT,
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scan_gaps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scan_gaps_chain_closed_at_idx" ON "scan_gaps"("chain", "closed_at");

