export const flags = {
  ENABLE_LLM_CONTACT_EXTRACTION: true,
  ENABLE_AUTO_MODE: true,
  ENABLE_FOLLOWUP_CRON: true,
  ENABLE_QUALITY_REVIEW: false,
  // NB: the agency rollout/kill-switch flags (campaign_types, agency_sourcing,
  // object_storage, blogger_matching) are RUNTIME flags now — they live in the
  // DB and are read via getFeatureFlags().get(...), NOT here. See
  // packages/shared/src/feature-flags.ts (runtime-feature-flags change).
  MAX_DRY_RUN_TOKENS: 4000,
  DEFAULT_DAILY_MSG_LIMIT: 30,
  DEFAULT_DAILY_NEW_CONTACT_LIMIT: 15,
  WARMUP_STAGES: [5, 10, 20, 30, 50],
} as const;

export type FeatureFlag = keyof typeof flags;
