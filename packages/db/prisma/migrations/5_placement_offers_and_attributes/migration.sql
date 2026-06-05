-- Structured placement offers (entity-style-rate-cards change).
-- Offers are stored as typed JSON: rolled up onto blogger_profile.placement_offers
-- and persisted per-message as profile_data_point rows (field='placement.offer').
ALTER TABLE "blogger_profile" ADD COLUMN "placement_offers" JSONB NOT NULL DEFAULT '[]';

-- Placement attribute registry + LLM proposals. status='active' rows are the
-- active registry (seeded from PLACEMENT_ATTRIBUTE_REGISTRY_V1 + approvals);
-- status='proposed' rows are inactive review drafts.
CREATE TABLE "placement_attribute" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value_type" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "applicable_kinds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enum_values" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "required_for_kinds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "confidence" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "rationale" TEXT NOT NULL DEFAULT '',
    "source_message_id" TEXT,
    "proposed_by_run_id" TEXT,
    "reviewed_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "placement_attribute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "placement_attribute_status_idx" ON "placement_attribute"("status");

-- CreateIndex
CREATE INDEX "placement_attribute_key_status_idx" ON "placement_attribute"("key", "status");
