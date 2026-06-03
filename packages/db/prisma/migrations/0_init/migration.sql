-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('admin', 'operator', 'viewer');

-- CreateEnum
CREATE TYPE "platform" AS ENUM ('telegram', 'instagram', 'youtube');

-- CreateEnum
CREATE TYPE "tg_account_status" AS ENUM ('idle', 'active', 'cooldown', 'banned', 'need_auth');

-- CreateEnum
CREATE TYPE "tg_account_role" AS ENUM ('parser', 'outreach', 'both');

-- CreateEnum
CREATE TYPE "llm_provider_kind" AS ENUM ('yandex', 'openrouter', 'openai_compat');

-- CreateEnum
CREATE TYPE "channel_status" AS ENUM ('new', 'scraping', 'scraped', 'extracting', 'extracted', 'ready', 'done', 'failed');

-- CreateEnum
CREATE TYPE "contact_type" AS ENUM ('tg_username', 'tg_phone', 'tg_link', 'email', 'website', 'web_form', 'other');

-- CreateEnum
CREATE TYPE "role_guess" AS ENUM ('owner', 'ad_manager', 'generic', 'bot', 'unknown');

-- CreateEnum
CREATE TYPE "reachability" AS ENUM ('reachable_tg', 'manual', 'unreachable');

-- CreateEnum
CREATE TYPE "contact_status" AS ENUM ('new', 'qualified', 'disqualified', 'contacted', 'active', 'finished', 'invalid', 'blocked');

-- CreateEnum
CREATE TYPE "extracted_by" AS ENUM ('regex', 'llm', 'both', 'manual');

-- CreateEnum
CREATE TYPE "campaign_status" AS ENUM ('draft', 'running', 'paused', 'finished');

-- CreateEnum
CREATE TYPE "conversation_mode" AS ENUM ('auto', 'semi_auto', 'assisted', 'manual');

-- CreateEnum
CREATE TYPE "conversation_status" AS ENUM ('active', 'paused', 'done', 'failed');

-- CreateEnum
CREATE TYPE "message_direction" AS ENUM ('in_', 'out_');

-- CreateEnum
CREATE TYPE "message_sender" AS ENUM ('contact', 'ai', 'operator', 'system');

-- CreateEnum
CREATE TYPE "message_status" AS ENUM ('pending', 'sending', 'sent', 'failed', 'received');

-- CreateEnum
CREATE TYPE "suggestion_status" AS ENUM ('pending', 'approved', 'edited', 'rejected', 'sent', 'expired');

-- CreateEnum
CREATE TYPE "agent_run_status" AS ENUM ('ok', 'fallback', 'failed');

-- CreateEnum
CREATE TYPE "media_asset_kind" AS ENUM ('media_kit', 'screenshot', 'document', 'image', 'video', 'raw_payload', 'other');

-- CreateEnum
CREATE TYPE "discovery_batch_status" AS ENUM ('pending', 'running', 'done', 'failed');

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "user_role" NOT NULL DEFAULT 'operator',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tg_account" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "session_encrypted" TEXT,
    "status" "tg_account_status" NOT NULL DEFAULT 'need_auth',
    "role" "tg_account_role" NOT NULL DEFAULT 'both',
    "daily_msg_limit" INTEGER NOT NULL DEFAULT 30,
    "daily_new_contact_limit" INTEGER NOT NULL DEFAULT 15,
    "sent_today_msg" INTEGER NOT NULL DEFAULT 0,
    "sent_today_new" INTEGER NOT NULL DEFAULT 0,
    "day_rolled_at" TIMESTAMP(3),
    "cooldown_until" TIMESTAMP(3),
    "warmup_started_at" TIMESTAMP(3),
    "warmup_stage" INTEGER NOT NULL DEFAULT 0,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "login_phone_code_hash" TEXT,
    "device_fingerprint" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tg_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "config_encrypted" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT,
    "last_check_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "endpoint" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" "llm_provider_kind" NOT NULL,
    "base_url" TEXT NOT NULL,
    "auth_encrypted" TEXT NOT NULL,
    "default_headers" JSONB NOT NULL DEFAULT '{}',
    "rate_limit_rpm" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "endpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel" (
    "id" TEXT NOT NULL,
    "platform" "platform" NOT NULL,
    "external_id" TEXT,
    "handle" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "links" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "followers" INTEGER,
    "language" TEXT,
    "raw_data" JSONB,
    "analysis" JSONB,
    "status" "channel_status" NOT NULL DEFAULT 'new',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "added_by_id" TEXT,
    "scraped_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact" (
    "id" TEXT NOT NULL,
    "channel_id" TEXT,
    "type" "contact_type" NOT NULL,
    "value" TEXT NOT NULL,
    "raw_value" TEXT NOT NULL,
    "label" TEXT,
    "role_guess" "role_guess" NOT NULL DEFAULT 'unknown',
    "confidence" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "extracted_by" "extracted_by" NOT NULL DEFAULT 'regex',
    "reachability" "reachability" NOT NULL DEFAULT 'manual',
    "status" "contact_status" NOT NULL DEFAULT 'new',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tg_user_id" TEXT,
    "tg_username" TEXT,
    "tg_first_name" TEXT,
    "tg_last_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "goal_text" TEXT NOT NULL,
    "value_prop" TEXT NOT NULL,
    "type_id" TEXT NOT NULL,
    "goal" JSONB,
    "target_filter" JSONB NOT NULL DEFAULT '{}',
    "agent_overrides" JSONB NOT NULL DEFAULT '{}',
    "outreach_account_pool" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "schedule" JSONB NOT NULL DEFAULT '{}',
    "default_mode" "conversation_mode" NOT NULL DEFAULT 'assisted',
    "status" "campaign_status" NOT NULL DEFAULT 'draft',
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation" (
    "id" TEXT NOT NULL,
    "tg_account_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "campaign_id" TEXT,
    "status" "conversation_status" NOT NULL DEFAULT 'active',
    "mode" "conversation_mode" NOT NULL DEFAULT 'assisted',
    "assigned_operator_id" TEXT,
    "last_inbound_at" TIMESTAMP(3),
    "last_outbound_at" TIMESTAMP(3),
    "quality_decision" JSONB,
    "last_synced_at" TIMESTAMP(3),
    "summary" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "tg_msg_id" TEXT,
    "direction" "message_direction" NOT NULL,
    "sender" "message_sender" NOT NULL,
    "text" TEXT NOT NULL,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "status" "message_status" NOT NULL DEFAULT 'pending',
    "suggestion_id" TEXT,
    "operator_id" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opener_variant" TEXT,

    CONSTRAINT "message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suggestion" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "agent_name" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "rationale" TEXT NOT NULL DEFAULT '',
    "score" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "status" "suggestion_status" NOT NULL DEFAULT 'pending',
    "meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "suggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_config" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "endpoint_id" TEXT,
    "fallback_endpoint_id" TEXT,
    "model" TEXT NOT NULL DEFAULT '',
    "system_prompt" TEXT NOT NULL DEFAULT '',
    "user_prompt_template" TEXT NOT NULL DEFAULT '',
    "params" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_config_history" (
    "id" TEXT NOT NULL,
    "agent_config_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changed_by_id" TEXT,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_config_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_run" (
    "id" TEXT NOT NULL,
    "agent_name" TEXT NOT NULL,
    "channel_id" TEXT,
    "contact_id" TEXT,
    "conversation_id" TEXT,
    "endpoint_id" TEXT,
    "model" TEXT,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "tokens_in" INTEGER NOT NULL DEFAULT 0,
    "tokens_out" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "latency_ms" INTEGER NOT NULL DEFAULT 0,
    "status" "agent_run_status" NOT NULL DEFAULT 'ok',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tg_op_log" (
    "id" TEXT NOT NULL,
    "tg_account_id" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "latency_ms" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tg_op_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_type" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "goal_schema" JSONB NOT NULL DEFAULT '{}',
    "agent_set" JSONB NOT NULL DEFAULT '{}',
    "safety_profile" JSONB NOT NULL DEFAULT '{}',
    "autonomy_policy" JSONB NOT NULL DEFAULT '{}',
    "built_in" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flag" (
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT NOT NULL DEFAULT '',
    "updated_by_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feature_flag_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "discovery_batch" (
    "id" TEXT NOT NULL,
    "queries" JSONB NOT NULL,
    "platform" TEXT,
    "limit_per_query" INTEGER NOT NULL DEFAULT 20,
    "status" "discovery_batch_status" NOT NULL DEFAULT 'pending',
    "summary" JSONB NOT NULL DEFAULT '{}',
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "discovery_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blogger_profile" (
    "id" TEXT NOT NULL,
    "channel_id" TEXT,
    "topics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "formats" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "audience" JSONB NOT NULL DEFAULT '{}',
    "rate_cards" JSONB NOT NULL DEFAULT '[]',
    "reach" INTEGER,
    "avg_views" INTEGER,
    "captured_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blogger_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profile_data_point" (
    "id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "unit" TEXT,
    "confidence" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "extracted_by" TEXT NOT NULL DEFAULT 'llm',
    "source_message_id" TEXT,
    "raw_snippet" TEXT NOT NULL DEFAULT '',
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profile_data_point_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_asset" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT,
    "profile_id" TEXT,
    "kind" "media_asset_kind" NOT NULL DEFAULT 'other',
    "s3_key" TEXT NOT NULL,
    "mime" TEXT,
    "bytes" INTEGER,
    "sha256" TEXT,
    "source_tg_msg_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_brief" (
    "id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "audience_target" TEXT NOT NULL DEFAULT '',
    "budget" INTEGER,
    "formats" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "geo" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deadline" TIMESTAMP(3),
    "notes" TEXT NOT NULL DEFAULT '',
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_brief_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_result" (
    "id" TEXT NOT NULL,
    "brief_id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "score" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "rationale" TEXT NOT NULL DEFAULT '',
    "reranked_by_llm" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_result_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "tg_account_phone_key" ON "tg_account"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "integration_kind_key" ON "integration"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "endpoint_name_key" ON "endpoint"("name");

-- CreateIndex
CREATE INDEX "channel_status_idx" ON "channel"("status");

-- CreateIndex
CREATE UNIQUE INDEX "channel_platform_external_id_key" ON "channel"("platform", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_platform_handle_key" ON "channel"("platform", "handle");

-- CreateIndex
CREATE INDEX "contact_status_reachability_idx" ON "contact"("status", "reachability");

-- CreateIndex
CREATE UNIQUE INDEX "contact_channel_id_type_value_key" ON "contact"("channel_id", "type", "value");

-- CreateIndex
CREATE INDEX "campaign_type_id_idx" ON "campaign"("type_id");

-- CreateIndex
CREATE INDEX "conversation_last_inbound_at_idx" ON "conversation"("last_inbound_at");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_tg_account_id_contact_id_key" ON "conversation"("tg_account_id", "contact_id");

-- CreateIndex
CREATE INDEX "message_conversation_id_created_at_idx" ON "message"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "message_conversation_id_opener_variant_idx" ON "message"("conversation_id", "opener_variant");

-- CreateIndex
CREATE INDEX "suggestion_conversation_id_status_idx" ON "suggestion"("conversation_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "agent_config_name_key" ON "agent_config"("name");

-- CreateIndex
CREATE INDEX "agent_run_agent_name_created_at_idx" ON "agent_run"("agent_name", "created_at");

-- CreateIndex
CREATE INDEX "tg_op_log_tg_account_id_created_at_idx" ON "tg_op_log"("tg_account_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_created_at_idx" ON "audit_log"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_type_key_key" ON "campaign_type"("key");

-- CreateIndex
CREATE INDEX "discovery_batch_status_created_at_idx" ON "discovery_batch"("status", "created_at");

-- CreateIndex
CREATE INDEX "discovery_batch_created_by_id_idx" ON "discovery_batch"("created_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "blogger_profile_channel_id_key" ON "blogger_profile"("channel_id");

-- CreateIndex
CREATE INDEX "profile_data_point_profile_id_field_idx" ON "profile_data_point"("profile_id", "field");

-- CreateIndex
CREATE INDEX "media_asset_conversation_id_idx" ON "media_asset"("conversation_id");

-- CreateIndex
CREATE INDEX "media_asset_profile_id_idx" ON "media_asset"("profile_id");

-- CreateIndex
CREATE INDEX "match_result_brief_id_idx" ON "match_result"("brief_id");

-- CreateIndex
CREATE INDEX "match_result_profile_id_idx" ON "match_result"("profile_id");

-- AddForeignKey
ALTER TABLE "channel" ADD CONSTRAINT "channel_added_by_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact" ADD CONSTRAINT "contact_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_type_id_fkey" FOREIGN KEY ("type_id") REFERENCES "campaign_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_tg_account_id_fkey" FOREIGN KEY ("tg_account_id") REFERENCES "tg_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_assigned_operator_id_fkey" FOREIGN KEY ("assigned_operator_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_suggestion_id_fkey" FOREIGN KEY ("suggestion_id") REFERENCES "suggestion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suggestion" ADD CONSTRAINT "suggestion_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_config" ADD CONSTRAINT "agent_config_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "endpoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_config" ADD CONSTRAINT "agent_config_fallback_endpoint_id_fkey" FOREIGN KEY ("fallback_endpoint_id") REFERENCES "endpoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_config" ADD CONSTRAINT "agent_config_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_config_history" ADD CONSTRAINT "agent_config_history_agent_config_id_fkey" FOREIGN KEY ("agent_config_id") REFERENCES "agent_config"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_config_history" ADD CONSTRAINT "agent_config_history_changed_by_id_fkey" FOREIGN KEY ("changed_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "endpoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tg_op_log" ADD CONSTRAINT "tg_op_log_tg_account_id_fkey" FOREIGN KEY ("tg_account_id") REFERENCES "tg_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_data_point" ADD CONSTRAINT "profile_data_point_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "blogger_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_asset" ADD CONSTRAINT "media_asset_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "blogger_profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_result" ADD CONSTRAINT "match_result_brief_id_fkey" FOREIGN KEY ("brief_id") REFERENCES "ad_brief"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_result" ADD CONSTRAINT "match_result_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "blogger_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Partial unique index for cold leads (channel_id IS NULL). The regular
-- @@unique([channelId, type, value]) doesn't dedupe these because Postgres
-- treats NULL as distinct in unique constraints. Carried over from the
-- original migration 2_contact_cold_lead.
CREATE UNIQUE INDEX "contact_type_value_no_channel_key"
  ON "contact" ("type", "value")
  WHERE "channel_id" IS NULL;

-- Seed runtime feature flags (all OFF — matches FEATURE_FLAG_DEFAULTS in
-- packages/shared/feature-flags.ts). Idempotent so re-applying the migration
-- via `prisma migrate deploy` against an already-seeded DB is a no-op.
INSERT INTO "feature_flag" ("key", "enabled", "description", "updated_at", "created_at")
VALUES
  ('campaign_types',     false, 'Реестр типов кампаний + конструктор',                CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('agency_sourcing',    false, 'Агентский режим: сбор прайсов/охватов у блогеров',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('object_storage',     false, 'Хранение медиа/сырья в S3 (нужен S3_*)',             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('blogger_matching',   false, 'Подбор блогеров под бриф',                           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('channel_discovery',  false, 'Дискавери каналов по нише через Yandex Search',      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
