-- Blogger catalog post insights and richer match-fit metadata.

ALTER TABLE "blogger_profile"
  ADD COLUMN "post_insight_refresh_status" TEXT NOT NULL DEFAULT 'idle',
  ADD COLUMN "post_insight_refresh_error" TEXT,
  ADD COLUMN "post_insight_refreshed_at" TIMESTAMP(3);

CREATE TABLE "blogger_post_insight" (
  "id" TEXT NOT NULL,
  "profile_id" TEXT NOT NULL,
  "channel_id" TEXT,
  "platform" TEXT NOT NULL,
  "external_post_id" TEXT NOT NULL,
  "url" TEXT,
  "published_at" TIMESTAMP(3),
  "text_snippet" TEXT NOT NULL DEFAULT '',
  "media_kind" TEXT NOT NULL DEFAULT 'post',
  "metrics" JSONB NOT NULL DEFAULT '{}',
  "metric_captured_at" TIMESTAMP(3),
  "source" TEXT NOT NULL,
  "source_raw_ref" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "blogger_post_insight_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "blogger_post_insight_profile_id_platform_external_post_id_key"
  ON "blogger_post_insight"("profile_id", "platform", "external_post_id");

CREATE INDEX "blogger_post_insight_profile_id_published_at_idx"
  ON "blogger_post_insight"("profile_id", "published_at");

CREATE INDEX "blogger_post_insight_channel_id_idx"
  ON "blogger_post_insight"("channel_id");

ALTER TABLE "blogger_post_insight"
  ADD CONSTRAINT "blogger_post_insight_profile_id_fkey"
  FOREIGN KEY ("profile_id") REFERENCES "blogger_profile"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "match_result"
  ADD COLUMN "fit_signals" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "evidence_post_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
