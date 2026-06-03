## ADDED Requirements

### Requirement: Asset rows are backfilled when their owning profile is created later

When a `media_asset` row is written with `profile_id = null` because no `blogger_profile` exists for the conversation's channel yet, the asset SHALL become linked to the profile as soon as the profile is created. The link SHALL be established by `handleProfileExtract` (see `blogger-commercial-profile` capability) via `UPDATE media_asset SET profile_id = ? WHERE conversation_id = ? AND profile_id IS NULL`. No periodic backfill job is needed.

#### Scenario: First-inbound media kit is linked retroactively
- **WHEN** a media-kit PDF is stored as a `media_asset` with `profile_id = null` and a subsequent reply triggers profile creation
- **THEN** the asset's `profile_id` is updated to the new profile's id in the same transaction, observable via the profile's `mediaAssets` relation

#### Scenario: Subsequent assets in the same conversation get profile_id at write time
- **WHEN** a second media asset is written after the profile already exists
- **THEN** `media-store` sets `profile_id` at write time (existing behavior) and the backfill UPDATE in the next extraction is a no-op
