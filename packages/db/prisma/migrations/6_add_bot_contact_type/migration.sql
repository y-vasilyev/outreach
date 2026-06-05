-- Add the `bot` contact type (add-bot-contact-type change).
-- Some bloggers publish only an advertising/intake Telegram bot (e.g.
-- "по рекламе — @hadeout_bot") as their business contact. This models that
-- as a first-class ContactType. Appended at the end of the enum so this is a
-- pure additive `ADD VALUE` (no enum rewrite, forward-only, non-destructive).
ALTER TYPE "contact_type" ADD VALUE IF NOT EXISTS 'bot';
