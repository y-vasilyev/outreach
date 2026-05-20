-- 6_campaign_types
--
-- agency-sourcing-matching change. Additive schema for:
--   * CampaignType registry (config dictionary that drives pipelines).
--   * Campaign.typeId (FK, nullable during backfill) + Campaign.goal (JSONB).
--   * BloggerProfile / ProfileDataPoint (standardized catalog + provenance).
--   * MediaAsset (S3-backed file + raw-payload references).
--   * AdBrief / MatchResult (matching engine).
--
-- Built-in types `custdev` and `agency_sourcing` are inserted with stable
-- ids equal to their key so the backfill below and seed.ts can upsert them
-- idempotently. seed.ts owns the rich agentSet / safetyProfile content; the
-- JSON here is the minimal valid scaffold required for the backfill.

-- 1. Enums.
CREATE TYPE "MediaAssetKind" AS ENUM ('media_kit', 'screenshot', 'document', 'image', 'video', 'raw_payload', 'other');

-- 2. CampaignType registry.
CREATE TABLE "CampaignType" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "goalSchema" JSONB NOT NULL DEFAULT '{}',
    "agentSet" JSONB NOT NULL DEFAULT '{}',
    "safetyProfile" JSONB NOT NULL DEFAULT '{}',
    "autonomyPolicy" JSONB NOT NULL DEFAULT '{}',
    "builtIn" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignType_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CampaignType_key_key" ON "CampaignType"("key");

-- 3. Campaign.typeId + Campaign.goal.
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "typeId" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "goal" JSONB;
CREATE INDEX "Campaign_typeId_idx" ON "Campaign"("typeId");
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "CampaignType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. BloggerProfile.
CREATE TABLE "BloggerProfile" (
    "id" TEXT NOT NULL,
    "channelId" TEXT,
    "topics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "formats" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "audience" JSONB NOT NULL DEFAULT '{}',
    "rateCards" JSONB NOT NULL DEFAULT '[]',
    "reach" INTEGER,
    "avgViews" INTEGER,
    "capturedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BloggerProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BloggerProfile_channelId_key" ON "BloggerProfile"("channelId");

-- 5. ProfileDataPoint.
CREATE TABLE "ProfileDataPoint" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "unit" TEXT,
    "confidence" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "extractedBy" TEXT NOT NULL DEFAULT 'llm',
    "sourceMessageId" TEXT,
    "rawSnippet" TEXT NOT NULL DEFAULT '',
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfileDataPoint_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProfileDataPoint_profileId_field_idx" ON "ProfileDataPoint"("profileId", "field");
ALTER TABLE "ProfileDataPoint" ADD CONSTRAINT "ProfileDataPoint_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "BloggerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 6. MediaAsset.
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT,
    "profileId" TEXT,
    "kind" "MediaAssetKind" NOT NULL DEFAULT 'other',
    "s3Key" TEXT NOT NULL,
    "mime" TEXT,
    "bytes" INTEGER,
    "sha256" TEXT,
    "sourceTgMsgId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MediaAsset_conversationId_idx" ON "MediaAsset"("conversationId");
CREATE INDEX "MediaAsset_profileId_idx" ON "MediaAsset"("profileId");
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "BloggerProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 7. AdBrief.
CREATE TABLE "AdBrief" (
    "id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "audienceTarget" TEXT NOT NULL DEFAULT '',
    "budget" INTEGER,
    "formats" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "geo" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deadline" TIMESTAMP(3),
    "notes" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdBrief_pkey" PRIMARY KEY ("id")
);

-- 8. MatchResult.
CREATE TABLE "MatchResult" (
    "id" TEXT NOT NULL,
    "briefId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "score" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "rationale" TEXT NOT NULL DEFAULT '',
    "rerankedByLlm" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchResult_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MatchResult_briefId_idx" ON "MatchResult"("briefId");
CREATE INDEX "MatchResult_profileId_idx" ON "MatchResult"("profileId");
ALTER TABLE "MatchResult" ADD CONSTRAINT "MatchResult_briefId_fkey" FOREIGN KEY ("briefId") REFERENCES "AdBrief"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MatchResult" ADD CONSTRAINT "MatchResult_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "BloggerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 9. Seed built-in campaign types (minimal scaffold; seed.ts enriches).
--    custdev safety profile mirrors the legacy SafetyFilter defaults so the
--    backfilled CustDev campaigns keep blocking ad-sales vocabulary.
INSERT INTO "CampaignType" ("id", "key", "name", "description", "goalSchema", "agentSet", "safetyProfile", "autonomyPolicy", "builtIn", "enabled", "createdAt", "updatedAt")
VALUES
  (
    'custdev', 'custdev', 'CustDev интервью',
    'Приглашение на исследовательское интервью по продукту. Не продажа, не реклама.',
    '{}'::jsonb, '{}'::jsonb,
    jsonb_build_object(
      'forbidden_topics', jsonb_build_array('реклама','рекламная','интеграц','купить рекламу','разместить','промо','приобрести','оффер','выгодное предложение'),
      'allowed_topics', '[]'::jsonb,
      'allow_links', false,
      'max_length', 600
    ),
    '{}'::jsonb, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  ),
  (
    'agency_sourcing', 'agency_sourcing', 'Агентство по размещению рекламы',
    'Заход от лица агентства по рекламе: сбор прайсов, форматов, сроков, охватов и статистики аудитории.',
    '{}'::jsonb, '{}'::jsonb,
    jsonb_build_object(
      'forbidden_topics', '[]'::jsonb,
      'allowed_topics', jsonb_build_array('реклама','интеграция','прайс','охваты','формат','размещение'),
      'allow_links', false,
      'max_length', 800
    ),
    '{}'::jsonb, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
ON CONFLICT ("id") DO NOTHING;

-- 10. Backfill: every existing campaign becomes a `custdev`-type campaign,
--     moving its AJTBD into Campaign.goal (scaffold from goalText/valueProp
--     when the AJTBD is still null). Leaves typeId nullable for now; a
--     follow-up migration flips it to NOT NULL after verification.
UPDATE "Campaign"
SET "typeId" = 'custdev',
    "goal" = COALESCE(
      "ajtbd",
      jsonb_build_object(
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
    )
WHERE "typeId" IS NULL;
