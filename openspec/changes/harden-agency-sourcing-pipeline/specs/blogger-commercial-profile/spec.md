## ADDED Requirements

### Requirement: Media assets are linked to the blogger profile on creation

When `handleProfileExtract` creates a new `blogger_profile` row for a channel, it SHALL backfill `media_asset.profile_id` for any `media_asset` rows whose `conversation_id` equals the conversation that triggered profile creation and whose `profile_id` is currently NULL. Backfill SHALL run inside the same database transaction that creates the profile, so a reader never sees the profile without the assets that contributed to its inbound history being linked.

#### Scenario: Media kit arrives before profile exists, then profile is created
- **WHEN** an `agency_sourcing` blogger sends a media-kit PDF as their first inbound (creating a `media_asset` row with `profile_id = null`), and a subsequent reply triggers `handleProfileExtract` which upserts the `blogger_profile`
- **THEN** the just-created profile's `id` is written onto the media-kit `media_asset.profile_id` in the same transaction; the asset is queryable via the profile's `mediaAssets` relation

#### Scenario: Backfill is scoped to the conversation, not the channel
- **WHEN** two conversations exist for the same channel and a profile is created from conversation A
- **THEN** only assets with `conversation_id = A` and `profile_id = null` are backfilled; assets from conversation B are not touched on this transaction

#### Scenario: Backfill is idempotent on re-extraction
- **WHEN** `handleProfileExtract` runs again for the same conversation after the profile already exists with linked assets
- **THEN** the backfill `UPDATE … WHERE profile_id IS NULL` matches zero rows and is a no-op
