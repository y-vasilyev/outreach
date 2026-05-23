-- 4_chat_autonomous_modes
--
-- Additive schema for the chat-autonomous-modes change.
-- Adds:
--   * ConversationMode.semi_auto  (rename of legacy `auto`; the backfill
--     UPDATE that migrates legacy `auto` rows lives in a SEPARATE later
--     migration — see migration 9a_chat_modes_backfill_semi_auto.
--     The legacy `auto` value is kept in the enum for one release so the
--     API can normalize older payloads. A follow-up migration redefines
--     `auto` semantics — see openspec change `chat-autonomous-modes`
--     design.md Decision 1 and tasks 8.x.).
--   * Campaign.ajtbd                (JSONB, nullable, scaffolded from
--     goalText / valueProp).
--   * Conversation.qualityDecision  (JSONB, nullable).
--   * Conversation.lastSyncedAt     (TIMESTAMPTZ, nullable).
--
-- `ALTER TYPE ... ADD VALUE` itself runs fine inside the migration
-- transaction; the real Postgres constraint is that the newly-added
-- enum value cannot be USED (in casts, UPDATE, comparisons) until
-- after that transaction commits. The block comment below explains why
-- the backfill UPDATE is split out into a separate migration.
--
-- DO NOT use 'semi_auto' (or any newly-added enum value) anywhere else in
-- this file. Postgres forbids referring to a value added via
-- `ALTER TYPE ... ADD VALUE` in the same transaction in which it is
-- added, so a backfill UPDATE in this file would fail on a fresh cluster
-- with `unsafe use of new value 'semi_auto' of enum type
-- ConversationMode`. The backfill therefore lives in migration
-- `9a_chat_modes_backfill_semi_auto`, which runs in its own transaction
-- after this one commits. See openspec change `fix-migration-4-enum-tx`.

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

-- 5. Legacy `auto` → `semi_auto` backfill lives in migration
-- `9a_chat_modes_backfill_semi_auto` (separate transaction). See the
-- block comment at the top of this file and openspec change
-- `fix-migration-4-enum-tx` for the reasoning.
