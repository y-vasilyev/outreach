-- extraction-provenance: agent_run traceability + soft supersede on facts.
-- Additive: two nullable columns; operator re-run stops deleting rows and
-- stamps superseded_at instead. The partial index keeps default readers
-- (roll-up, HUD, idempotency) on live rows only.

-- AlterTable
ALTER TABLE "profile_data_point" ADD COLUMN "agent_run_id" TEXT;
ALTER TABLE "profile_data_point" ADD COLUMN "superseded_at" TIMESTAMP(3);

-- Partial index over LIVE rows (Prisma cannot express partial indexes).
CREATE INDEX "profile_data_point_live_profile_field_idx"
    ON "profile_data_point"("profile_id", "field")
    WHERE "superseded_at" IS NULL;
