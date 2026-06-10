-- placement-offer-table: first-class placement offer rows.
-- Derived, indexable projection of `placement.offer` profile_data_point facts:
-- typed columns for search (platform/kind/price bounds/identity attributes),
-- verbatim raw data (raw_price/raw_snippet/attributes), provenance references,
-- and an append-only lifecycle (active | superseded | low_confidence — rows
-- are never deleted). Purely additive; backfill from existing data points runs
-- separately via `pnpm db:backfill:offers`.

-- CreateTable
CREATE TABLE "placement_offer" (
    "id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "platform" TEXT,
    "kind" TEXT NOT NULL,
    "price_min" DECIMAL(65,30),
    "price_max" DECIMAL(65,30),
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "duration" TEXT,
    "tariff_name" TEXT,
    "slot" TEXT,
    "identity_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "superseded_by_id" TEXT,
    "confidence" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "attributes" JSONB NOT NULL DEFAULT '[]',
    "raw_price" TEXT NOT NULL DEFAULT '',
    "raw_snippet" TEXT NOT NULL DEFAULT '',
    "source_data_point_id" TEXT,
    "source_message_id" TEXT,
    "extracted_by" TEXT NOT NULL DEFAULT 'llm',
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "placement_offer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "placement_offer_profile_id_status_idx" ON "placement_offer"("profile_id", "status");
CREATE INDEX "placement_offer_platform_kind_price_min_idx" ON "placement_offer"("platform", "kind", "price_min");
CREATE INDEX "placement_offer_captured_at_idx" ON "placement_offer"("captured_at");
-- Idempotency key of the write/backfill helpers: one row per originating data
-- point. UNIQUE (partial — operator-created rows may have no data point) so a
-- backfill overlapping a live retry cannot insert a duplicate non-active row
-- past the findFirst check; the losing transaction fails and retries as a
-- no-op (codex review).
CREATE UNIQUE INDEX "placement_offer_profile_source_dp_key"
    ON "placement_offer"("profile_id", "source_data_point_id")
    WHERE "source_data_point_id" IS NOT NULL;
CREATE INDEX "placement_offer_profile_id_source_message_id_idx" ON "placement_offer"("profile_id", "source_message_id");

-- Partial unique: at most ONE active row per offer identity per profile.
-- Concurrent writers racing on the same identity fail here instead of
-- corrupting the supersede chain (design D4). Not expressible in Prisma
-- schema — raw SQL only; keep in sync manually if the table is ever reshaped.
CREATE UNIQUE INDEX "placement_offer_one_active_per_identity"
    ON "placement_offer"("profile_id", "identity_key")
    WHERE "status" = 'active';

-- AddForeignKey
ALTER TABLE "placement_offer" ADD CONSTRAINT "placement_offer_profile_id_fkey"
    FOREIGN KEY ("profile_id") REFERENCES "blogger_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
