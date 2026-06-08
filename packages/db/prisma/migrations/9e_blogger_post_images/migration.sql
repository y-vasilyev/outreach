-- Post-example images for the blogger profile (blogger-profile-who-is-this).
-- Telegram public post photos are stored to S3 under image_s3_key; YouTube
-- thumbnails are public URLs held in the same column and served directly.
-- Purely additive; existing rows default to 'pending' and populate on the next
-- post-insight refresh.

-- AlterTable
ALTER TABLE "blogger_post_insight" ADD COLUMN "image_s3_key" TEXT;
ALTER TABLE "blogger_post_insight" ADD COLUMN "image_status" TEXT DEFAULT 'pending';
