-- price-normalization-v2: operator-maintained exchange rates + derived
-- RUB-normalized columns and CPM on placement_offer. Purely additive; all new
-- offer columns are nullable (null = unnormalized, excluded from RUB
-- comparisons). No seed rows for exchange_rate — rates are set by an admin in
-- Settings; normalization never invents a rate.

-- CreateTable
CREATE TABLE "exchange_rate" (
    "currency" TEXT NOT NULL,
    "rate_to_rub" DECIMAL(65,30) NOT NULL,
    "as_of" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "updated_by_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_rate_pkey" PRIMARY KEY ("currency")
);

-- AlterTable: derived normalization columns (write-time + offer-renormalize job)
ALTER TABLE "placement_offer" ADD COLUMN "price_rub_min" DECIMAL(65,30);
ALTER TABLE "placement_offer" ADD COLUMN "price_rub_max" DECIMAL(65,30);
ALTER TABLE "placement_offer" ADD COLUMN "fx_rate_used" DECIMAL(65,30);
ALTER TABLE "placement_offer" ADD COLUMN "fx_as_of" TIMESTAMP(3);
ALTER TABLE "placement_offer" ADD COLUMN "cpm_rub" DECIMAL(65,30);
ALTER TABLE "placement_offer" ADD COLUMN "views_basis" INTEGER;
ALTER TABLE "placement_offer" ADD COLUMN "views_source" TEXT;

-- Partial index for CPM filters/sorts over the live catalog (catalog-sql-search).
CREATE INDEX "placement_offer_cpm_rub_active_idx"
    ON "placement_offer"("cpm_rub")
    WHERE "status" = 'active';
