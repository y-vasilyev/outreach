-- 8_feature_flags
--
-- runtime-feature-flags change. DB-backed source of truth for the
-- agency-sourcing-matching rollout/kill-switch flags (toggled from the admin
-- UI, cached per process, invalidated via Redis pub/sub). All seeded OFF —
-- exactly today's effective state — so the cutover is behavior-preserving.
-- (followup_cron / quality_review stay compile-time flags, not managed here.)

CREATE TABLE "FeatureFlag" (
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT NOT NULL DEFAULT '',
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY ("key")
);

INSERT INTO "FeatureFlag" ("key", "enabled", "description", "updatedAt", "createdAt")
VALUES
  ('campaign_types',   false, 'Реестр типов кампаний + конструктор',             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('agency_sourcing',  false, 'Агентский режим: сбор прайсов/охватов у блогеров', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('object_storage',   false, 'Хранение медиа/сырья в S3 (нужен S3_*)',           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('blogger_matching', false, 'Подбор блогеров под бриф',                         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
