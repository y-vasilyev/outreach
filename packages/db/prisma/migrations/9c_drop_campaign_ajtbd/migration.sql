-- 9c_drop_campaign_ajtbd
--
-- Drop the legacy `Campaign.ajtbd` JSON column now that
-- (a) every consumer reads `Campaign.goal` via the `extractAjtbdView`
--     helper (`packages/shared/src/schemas/ajtbd.ts`), and
-- (b) `9b_backfill_campaign_goal_from_ajtbd` populated `goal` from any
--     legacy `ajtbd` row.
--
-- See openspec change `drop-campaign-ajtbd-column`.
--
-- DESTRUCTIVE: data in `ajtbd` not present in `goal` is lost. Verified
-- safe because (i) the new write path keeps `goal` in sync with the
-- AJTBD form for CustDev campaigns, (ii) migration 9b copied any
-- residual rows to `goal`, (iii) we use the `IF EXISTS` guard so a
-- re-run after manual cleanup is harmless.

ALTER TABLE "Campaign" DROP COLUMN IF EXISTS "ajtbd";
