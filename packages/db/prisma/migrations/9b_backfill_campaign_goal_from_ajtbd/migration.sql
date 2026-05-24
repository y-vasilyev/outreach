-- 9b_backfill_campaign_goal_from_ajtbd
--
-- Backfill `Campaign.goal` from the legacy `Campaign.ajtbd` JSON column
-- for any row where `goal` is NULL but `ajtbd` still holds the AJTBD
-- payload. This guarantees no information is lost before the next
-- migration drops `ajtbd` entirely. See openspec change
-- `drop-campaign-ajtbd-column`.
--
-- Idempotent on a clean cluster (zero rows to update). On
-- already-migrated environments the new code path writes to `goal`
-- directly, so this typically also runs as a no-op.
--
-- Runs in its own transaction (separate file from the DROP migration),
-- so a partial backfill leaves the column intact.

UPDATE "Campaign"
   SET "goal" = "ajtbd"
 WHERE "goal" IS NULL
   AND "ajtbd" IS NOT NULL;
