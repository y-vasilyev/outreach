export const flags = {
  ENABLE_LLM_CONTACT_EXTRACTION: true,
  ENABLE_AUTO_MODE: true,
  ENABLE_FOLLOWUP_CRON: true,
  ENABLE_QUALITY_REVIEW: false,
  // Agency-sourcing-matching change. Default off — enabled in order
  // (campaign_types → agency_sourcing → object_storage → blogger_matching)
  // once the backfill migration has been verified. See
  // openspec/changes/agency-sourcing-matching.
  ENABLE_CAMPAIGN_TYPES: false,
  ENABLE_AGENCY_SOURCING: false,
  ENABLE_OBJECT_STORAGE: false,
  ENABLE_BLOGGER_MATCHING: false,
  MAX_DRY_RUN_TOKENS: 4000,
  DEFAULT_DAILY_MSG_LIMIT: 30,
  DEFAULT_DAILY_NEW_CONTACT_LIMIT: 15,
  WARMUP_STAGES: [5, 10, 20, 30, 50],
} as const;

export type FeatureFlag = keyof typeof flags;
