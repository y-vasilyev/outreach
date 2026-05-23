## MODIFIED Requirements

### Requirement: Storage is feature-flagged and degrades safely

Object storage SHALL be behind a feature flag with S3 connection config in environment. When storage is disabled or unreachable, the listener SHALL log a warning and skip media persistence rather than failing inbound processing or dropping the conversation.

The `tg-client` adapter responsible for fetching inbound media bytes (`downloadInboundMedia`) SHALL be best-effort: any failure mode (missing message, message without media, GramJS throw, non-binary download result) SHALL resolve to `null` rather than throwing, so the listener writes an honest-pending `media_asset` row (empty `s3Key`) instead of crashing the inbound pipeline. The set of failure modes SHALL be covered by unit tests against a mocked GramJS surface.

#### Scenario: Missing storage does not break inbound handling

- **WHEN** object storage is disabled in a dev environment and a media message arrives
- **THEN** the inbound text is still processed, a warning is logged, and the conversation is not moved to a failed state

#### Scenario: Storage enabled in CI uses local-compatible endpoint

- **WHEN** integration tests run with the storage flag on
- **THEN** assets are written to and read back from the configured S3-compatible endpoint (e.g. MinIO from compose)

#### Scenario: downloadInboundMedia never throws on any GramJS failure

- **WHEN** the GramJS-backed `downloadInboundMedia(...)` adapter encounters any failure (`getMessages` returns `[]`, message has no `media`, `downloadMedia` is absent on the client, `downloadMedia` throws, or the result is null/non-binary)
- **THEN** the call SHALL resolve to `null` (not throw); the listener writes an honest-pending `media_asset` row and inbound processing continues unaffected

#### Scenario: downloadInboundMedia returns bytes on success

- **WHEN** GramJS returns a message with media and `downloadMedia` resolves to bytes (`Uint8Array`, `Buffer`, or `string` payload)
- **THEN** the adapter SHALL return a `Uint8Array` containing those bytes (strings encoded via UTF-8) so the media-store can compute a deterministic s3Key and persist the asset
