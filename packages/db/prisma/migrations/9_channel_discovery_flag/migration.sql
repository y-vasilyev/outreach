-- 9_channel_discovery_flag
--
-- channel-discovery-search change. Seeds the runtime feature flag for the
-- web-search channel discovery feature (default OFF — enabled from the admin
-- Features UI). Idempotent.

INSERT INTO "FeatureFlag" ("key", "enabled", "description", "updatedAt", "createdAt")
VALUES ('channel_discovery', false, 'Дискавери каналов по нише через Yandex Search', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
