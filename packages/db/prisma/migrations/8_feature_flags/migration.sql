-- 8_feature_flags
--
-- runtime-feature-flags change. DB-backed source of truth for operational
-- rollout/kill-switch flags (toggled from the admin UI, cached per process,
-- invalidated via Redis pub/sub). Seeded to match the prior compile-time
-- defaults so the cutover is behavior-preserving (rollout flags off;
-- followup_cron on).

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
  ('campaign_types',   false, 'Реестр типов кампаний + конструктор',                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('agency_sourcing',  false, 'Агентский режим: сбор прайсов/охватов у блогеров',     CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('object_storage',   false, 'Хранение медиа/сырья в S3 (нужен S3_*)',               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('blogger_matching', false, 'Подбор блогеров под бриф',                             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('quality_review',   false, 'Оффлайн quality-review сэмпл исходящих',               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('followup_cron',    true,  'Крон фоллоуапов по тихим диалогам',                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
