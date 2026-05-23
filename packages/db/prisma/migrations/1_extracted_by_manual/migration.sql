-- Add `manual` to ExtractedBy so operator-edited contacts can be marked
-- and skipped by the contact-extract worker on re-run.
ALTER TYPE "ExtractedBy" ADD VALUE 'manual';
