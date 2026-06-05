-- Add the `archived` conversation status (inbox-archive-delete change).
-- Lets an operator park an off-target ("нецелевка") chat out of the working
-- inbox without deleting it (reversible → active). Appended at the end of the
-- enum so this is a pure additive `ADD VALUE` (no enum rewrite, forward-only,
-- non-destructive).
ALTER TYPE "conversation_status" ADD VALUE IF NOT EXISTS 'archived';
