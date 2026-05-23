-- 7_campaign_type_required
--
-- agency-sourcing-matching rollout step: every campaign now carries a type
-- (backfilled to `custdev` in migration 6). Flip Campaign.typeId to NOT NULL
-- and make the FK RESTRICT so a campaign type that is in use cannot be
-- deleted. The legacy `ajtbd` column is intentionally RETAINED for one
-- release (rollback safety); a later migration drops it once the `goal`
-- column is the sole source of truth in production.

ALTER TABLE "Campaign" ALTER COLUMN "typeId" SET NOT NULL;

ALTER TABLE "Campaign" DROP CONSTRAINT "Campaign_typeId_fkey";
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_typeId_fkey"
  FOREIGN KEY ("typeId") REFERENCES "CampaignType"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
