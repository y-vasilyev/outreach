-- Backfill campaigns created after migration 4 but before API-level AJTBD
-- persistence was fixed. Keeps on_inbound/followup pipelines from failing
-- loudly on Campaign.ajtbd IS NULL.
UPDATE "Campaign"
SET "ajtbd" = jsonb_build_object(
  'job', "goalText",
  'when', '',
  'forces', jsonb_build_object(
    'push', '[]'::jsonb,
    'pull', '[]'::jsonb,
    'anxieties', '[]'::jsonb,
    'habits', '[]'::jsonb
  ),
  'desired_outcome', "valueProp",
  'non_goals', '[]'::jsonb
)
WHERE "ajtbd" IS NULL;
