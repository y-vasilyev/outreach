-- 4_chat_autonomous_modes
--
-- Additive schema for the chat-autonomous-modes change.
-- Adds:
--   * ConversationMode.semi_auto  (rename of legacy `auto`; legacy rows
--     get migrated below; the legacy `auto` value is kept in the enum
--     for one release so the API can normalize older payloads. A
--     follow-up migration redefines `auto` semantics — see openspec
--     change `chat-autonomous-modes` design.md Decision 1 and
--     tasks 8.x.).
--   * Campaign.ajtbd                (JSONB, nullable, scaffolded from
--     goalText / valueProp).
--   * Conversation.qualityDecision  (JSONB, nullable).
--   * Conversation.lastSyncedAt     (TIMESTAMPTZ, nullable).
--
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction in Postgres,
-- so it lives in its own statement. Prisma's migration runner handles
-- that case automatically.

-- 1. Enum: add `semi_auto` (legacy `auto` stays for now, see Decision 1).
ALTER TYPE "ConversationMode" ADD VALUE IF NOT EXISTS 'semi_auto';

-- 2. Campaign.ajtbd column.
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "ajtbd" JSONB;

-- 3. Backfill ajtbd for existing campaigns from goalText / valueProp so
-- agents downstream always have a non-null AJTBD to consume. Empty
-- forces / non_goals — operators are expected to fill them in via the
-- admin UI.
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

-- 4. Conversation.qualityDecision and lastSyncedAt columns.
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "qualityDecision" JSONB;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "lastSyncedAt" TIMESTAMP(3);

-- 5. Migrate any legacy `auto` rows over to `semi_auto`. Today's `auto`
-- behaviour matches semi_auto semantics (auto-send when safe, fall
-- through to suggestion otherwise); the new strict `auto` is introduced
-- in the application layer at the same time as this migration.
UPDATE "Conversation" SET "mode" = 'semi_auto' WHERE "mode" = 'auto';
UPDATE "Campaign"     SET "defaultMode" = 'semi_auto' WHERE "defaultMode" = 'auto';
