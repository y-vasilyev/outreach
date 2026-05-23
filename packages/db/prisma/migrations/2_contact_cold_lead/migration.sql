-- Allow Contact rows that aren't bound to a Channel ("cold leads" — pasted
-- by the operator outside the scrape pipeline). The existing
-- (channelId, type, value) unique still enforces dedupe for channel-bound
-- contacts; for cold leads (where channelId IS NULL) Postgres treats NULLs
-- as distinct in regular unique indexes, so we add a partial unique index
-- on (type, value) WHERE channelId IS NULL to dedupe them too.
ALTER TABLE "Contact" ALTER COLUMN "channelId" DROP NOT NULL;

CREATE UNIQUE INDEX "Contact_type_value_no_channel_key"
  ON "Contact"("type", "value")
  WHERE "channelId" IS NULL;
