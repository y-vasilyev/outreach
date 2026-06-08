-- Attachment OCR (attachment-ocr-ingestion). Caches vision-OCR of inbound image
-- attachments on the media_asset so prices/reach inside screenshots/media kits
-- feed extraction. Purely additive; existing rows default to 'pending' and are
-- OCR'd lazily on the next extraction/re-run.

-- AlterTable
ALTER TABLE "media_asset" ADD COLUMN "ocr_text" TEXT;
ALTER TABLE "media_asset" ADD COLUMN "ocr_status" TEXT DEFAULT 'pending';
-- Stale-claim recovery: timestamp of the current `processing` OCR claim so a
-- crashed worker's claim can be reclaimed after a timeout.
ALTER TABLE "media_asset" ADD COLUMN "ocr_claimed_at" TIMESTAMP(3);
