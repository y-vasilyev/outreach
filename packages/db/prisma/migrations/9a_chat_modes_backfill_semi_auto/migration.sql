-- 9a_chat_modes_backfill_semi_auto
--
-- Backfill any legacy `mode = 'auto'` / `defaultMode = 'auto'` rows over
-- to `semi_auto`. This work was originally co-located with the enum
-- addition in migration `4_chat_autonomous_modes`, but Postgres forbids
-- using a value added via `ALTER TYPE ... ADD VALUE` in the same
-- transaction in which it is added — so the backfill is split out into
-- this migration, which runs in its own transaction after migration 4
-- has committed. See openspec change `fix-migration-4-enum-tx`.
--
-- Naming note: Prisma orders migrations lexicographically. We use the
-- `9a_` prefix (rather than `10_`) because ASCII `0` < `_` so `10_*`
-- would sort BEFORE `1_*`, `2_*`, … `9_*` and run far too early. The
-- `9a_` prefix keeps the migration immediately after `9_*` in sort order
-- while staying within the existing single-digit numbering scheme.
--
-- Today's legacy `auto` behaviour matches `semi_auto` semantics (auto-
-- send when safe, fall through to suggestion otherwise); the new strict
-- `auto` is introduced in the application layer at the same time as
-- migration 4. Renaming legacy rows therefore preserves existing
-- behaviour.
--
-- Idempotent on a clean cluster: on a fresh database there are no rows
-- whose mode is `auto`, so both UPDATEs are no-ops.

UPDATE "Conversation" SET "mode" = 'semi_auto' WHERE "mode" = 'auto';
UPDATE "Campaign"     SET "defaultMode" = 'semi_auto' WHERE "defaultMode" = 'auto';
