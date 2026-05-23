-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'operator', 'viewer');

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('telegram', 'instagram', 'youtube');

-- CreateEnum
CREATE TYPE "TgAccountStatus" AS ENUM ('idle', 'active', 'cooldown', 'banned', 'need_auth');

-- CreateEnum
CREATE TYPE "TgAccountRole" AS ENUM ('parser', 'outreach', 'both');

-- CreateEnum
CREATE TYPE "LLMProviderKind" AS ENUM ('yandex', 'openrouter', 'openai_compat');

-- CreateEnum
CREATE TYPE "ChannelStatus" AS ENUM ('new', 'scraping', 'scraped', 'extracting', 'extracted', 'ready', 'done', 'failed');

-- CreateEnum
CREATE TYPE "ContactType" AS ENUM ('tg_username', 'tg_phone', 'tg_link', 'email', 'website', 'web_form', 'other');

-- CreateEnum
CREATE TYPE "RoleGuess" AS ENUM ('owner', 'ad_manager', 'generic', 'bot', 'unknown');

-- CreateEnum
CREATE TYPE "Reachability" AS ENUM ('reachable_tg', 'manual', 'unreachable');

-- CreateEnum
CREATE TYPE "ContactStatus" AS ENUM ('new', 'qualified', 'disqualified', 'contacted', 'active', 'finished', 'invalid', 'blocked');

-- CreateEnum
CREATE TYPE "ExtractedBy" AS ENUM ('regex', 'llm', 'both');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('draft', 'running', 'paused', 'finished');

-- CreateEnum
CREATE TYPE "ConversationMode" AS ENUM ('auto', 'assisted', 'manual');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('active', 'paused', 'done', 'failed');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('in_', 'out_');

-- CreateEnum
CREATE TYPE "MessageSender" AS ENUM ('contact', 'ai', 'operator', 'system');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('pending', 'sending', 'sent', 'failed', 'received');

-- CreateEnum
CREATE TYPE "SuggestionStatus" AS ENUM ('pending', 'approved', 'edited', 'rejected', 'sent', 'expired');

-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('ok', 'fallback', 'failed');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'operator',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TgAccount" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "sessionEncrypted" TEXT,
    "status" "TgAccountStatus" NOT NULL DEFAULT 'need_auth',
    "role" "TgAccountRole" NOT NULL DEFAULT 'both',
    "dailyMsgLimit" INTEGER NOT NULL DEFAULT 30,
    "dailyNewContactLimit" INTEGER NOT NULL DEFAULT 15,
    "sentTodayMsg" INTEGER NOT NULL DEFAULT 0,
    "sentTodayNew" INTEGER NOT NULL DEFAULT 0,
    "dayRolledAt" TIMESTAMP(3),
    "cooldownUntil" TIMESTAMP(3),
    "warmupStartedAt" TIMESTAMP(3),
    "warmupStage" INTEGER NOT NULL DEFAULT 0,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "loginPhoneCodeHash" TEXT,
    "deviceFingerprint" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TgAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "configEncrypted" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT,
    "lastCheckAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Endpoint" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" "LLMProviderKind" NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "authEncrypted" TEXT NOT NULL,
    "defaultHeaders" JSONB NOT NULL DEFAULT '{}',
    "rateLimitRpm" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Endpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Channel" (
    "id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "externalId" TEXT,
    "handle" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "links" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "followers" INTEGER,
    "language" TEXT,
    "rawData" JSONB,
    "analysis" JSONB,
    "status" "ChannelStatus" NOT NULL DEFAULT 'new',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "addedById" TEXT,
    "scrapedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "type" "ContactType" NOT NULL,
    "value" TEXT NOT NULL,
    "rawValue" TEXT NOT NULL,
    "label" TEXT,
    "roleGuess" "RoleGuess" NOT NULL DEFAULT 'unknown',
    "confidence" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "extractedBy" "ExtractedBy" NOT NULL DEFAULT 'regex',
    "reachability" "Reachability" NOT NULL DEFAULT 'manual',
    "status" "ContactStatus" NOT NULL DEFAULT 'new',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tgUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "goalText" TEXT NOT NULL,
    "valueProp" TEXT NOT NULL,
    "targetFilter" JSONB NOT NULL DEFAULT '{}',
    "agentOverrides" JSONB NOT NULL DEFAULT '{}',
    "outreachAccountPool" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "schedule" JSONB NOT NULL DEFAULT '{}',
    "defaultMode" "ConversationMode" NOT NULL DEFAULT 'assisted',
    "status" "CampaignStatus" NOT NULL DEFAULT 'draft',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "tgAccountId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "campaignId" TEXT,
    "status" "ConversationStatus" NOT NULL DEFAULT 'active',
    "mode" "ConversationMode" NOT NULL DEFAULT 'assisted',
    "assignedOperatorId" TEXT,
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "summary" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "tgMsgId" TEXT,
    "direction" "MessageDirection" NOT NULL,
    "sender" "MessageSender" NOT NULL,
    "text" TEXT NOT NULL,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "status" "MessageStatus" NOT NULL DEFAULT 'pending',
    "suggestionId" TEXT,
    "operatorId" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Suggestion" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "rationale" TEXT NOT NULL DEFAULT '',
    "score" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "status" "SuggestionStatus" NOT NULL DEFAULT 'pending',
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "Suggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentConfig" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "endpointId" TEXT,
    "fallbackEndpointId" TEXT,
    "model" TEXT NOT NULL DEFAULT '',
    "systemPrompt" TEXT NOT NULL DEFAULT '',
    "userPromptTemplate" TEXT NOT NULL DEFAULT '',
    "params" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentConfigHistory" (
    "id" TEXT NOT NULL,
    "agentConfigId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changedById" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentConfigHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "channelId" TEXT,
    "contactId" TEXT,
    "conversationId" TEXT,
    "endpointId" TEXT,
    "model" TEXT,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'ok',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TgOpLog" (
    "id" TEXT NOT NULL,
    "tgAccountId" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TgOpLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "TgAccount_phone_key" ON "TgAccount"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_kind_key" ON "Integration"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "Endpoint_name_key" ON "Endpoint"("name");

-- CreateIndex
CREATE INDEX "Channel_status_idx" ON "Channel"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Channel_platform_externalId_key" ON "Channel"("platform", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Channel_platform_handle_key" ON "Channel"("platform", "handle");

-- CreateIndex
CREATE INDEX "Contact_status_reachability_idx" ON "Contact"("status", "reachability");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_channelId_type_value_key" ON "Contact"("channelId", "type", "value");

-- CreateIndex
CREATE INDEX "Conversation_lastInboundAt_idx" ON "Conversation"("lastInboundAt");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_tgAccountId_contactId_key" ON "Conversation"("tgAccountId", "contactId");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "Suggestion_conversationId_status_idx" ON "Suggestion"("conversationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AgentConfig_name_key" ON "AgentConfig"("name");

-- CreateIndex
CREATE INDEX "AgentRun_agentName_createdAt_idx" ON "AgentRun"("agentName", "createdAt");

-- CreateIndex
CREATE INDEX "TgOpLog_tgAccountId_createdAt_idx" ON "TgOpLog"("tgAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_tgAccountId_fkey" FOREIGN KEY ("tgAccountId") REFERENCES "TgAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_assignedOperatorId_fkey" FOREIGN KEY ("assignedOperatorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "Suggestion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Suggestion" ADD CONSTRAINT "Suggestion_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentConfig" ADD CONSTRAINT "AgentConfig_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentConfig" ADD CONSTRAINT "AgentConfig_fallbackEndpointId_fkey" FOREIGN KEY ("fallbackEndpointId") REFERENCES "Endpoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentConfig" ADD CONSTRAINT "AgentConfig_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentConfigHistory" ADD CONSTRAINT "AgentConfigHistory_agentConfigId_fkey" FOREIGN KEY ("agentConfigId") REFERENCES "AgentConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentConfigHistory" ADD CONSTRAINT "AgentConfigHistory_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TgOpLog" ADD CONSTRAINT "TgOpLog_tgAccountId_fkey" FOREIGN KEY ("tgAccountId") REFERENCES "TgAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

