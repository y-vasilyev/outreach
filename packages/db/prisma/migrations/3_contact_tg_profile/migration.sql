-- Resolved Telegram profile data for the contact. Populated by the
-- tg-send worker on the first outbound message (via TgClient.resolveUser),
-- then reused by:
--   - the opener / reply LLM pipelines, so the prompt has the real name
--     instead of hallucinating one;
--   - the tg-listen worker, which previously couldn't match an inbound
--     reply back to its contact reliably (no tgUserId until first ping).
ALTER TABLE "Contact"
  ADD COLUMN "tgUsername"  TEXT,
  ADD COLUMN "tgFirstName" TEXT,
  ADD COLUMN "tgLastName"  TEXT;
