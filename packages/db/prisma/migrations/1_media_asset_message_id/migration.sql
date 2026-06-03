-- Link MediaAsset to the owning chat Message so the inbox can render
-- inline previews for inbound media (S3 presigned URL keyed off
-- MediaAsset.id). Nullable to keep historical rows valid.

ALTER TABLE "media_asset" ADD COLUMN "message_id" TEXT;

CREATE INDEX "media_asset_message_id_idx" ON "media_asset"("message_id");

ALTER TABLE "media_asset"
  ADD CONSTRAINT "media_asset_message_id_fkey"
  FOREIGN KEY ("message_id") REFERENCES "message"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
