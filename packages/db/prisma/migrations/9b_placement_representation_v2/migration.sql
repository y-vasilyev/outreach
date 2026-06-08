-- Per-platform audience for the blogger catalog (placement-representation-v2).
-- Adds a rolled-up JSON column holding one entry per platform
-- `{ platform, subscribers, source, capturedAt }`, composed from
-- `audience.subscribers.<platform>` ProfileDataPoint rows. Purely additive:
-- the scalar reach/avg_views and the audience geo/age/gender map are untouched,
-- and the column defaults to '[]' so existing rows need no backfill.

-- AlterTable
ALTER TABLE "blogger_profile" ADD COLUMN "platform_audience" JSONB NOT NULL DEFAULT '[]';
