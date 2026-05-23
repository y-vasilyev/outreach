## ADDED Requirements

### Requirement: Store inbound files and raw payloads in object storage

When an inbound message carries media (media kits, stat screenshots, documents), the system SHALL download it and store it in S3-compatible object storage, recording a `media_asset` row `{ conversation_id, profile_id?, kind, s3_key, mime, bytes, sha256, source_tg_msg_id, created_at }`. Raw response payloads (verbatim text plus any parsed structured JSON) SHALL also be snapshotted to object storage under a deterministic key for later bulk analysis.

#### Scenario: Inbound media is persisted to S3
- **WHEN** a blogger sends a PDF media kit in an `agency_sourcing` conversation
- **THEN** the file is uploaded to object storage and a `media_asset` row links it to the conversation with its mime type, size, and sha256

#### Scenario: Raw payload snapshot is written
- **WHEN** an extractor parses a structured profile from a reply
- **THEN** the raw reply text and the parsed JSON are snapshotted to object storage under a deterministic key referenced from the profile data points

### Requirement: Keys are namespaced and access is presigned

Object keys SHALL be namespaced per blogger profile and asset (e.g. `bloggers/{profileId}/{assetId}`). The UI SHALL access assets only via short-lived presigned URLs issued by the API; raw bucket credentials SHALL NOT be exposed to the client and SHALL NOT be logged.

#### Scenario: UI downloads via presigned URL
- **WHEN** an operator opens a blogger profile and clicks a stored media kit
- **THEN** the API issues a short-lived presigned GET URL and the client fetches the file directly from storage

#### Scenario: Credentials are never logged
- **WHEN** asset upload or presign runs at any log level
- **THEN** no bucket secret or full credential string appears in logs (redacted)

### Requirement: Storage is feature-flagged and degrades safely

Object storage SHALL be behind a feature flag with S3 connection config in environment. When storage is disabled or unreachable, the listener SHALL log a warning and skip media persistence rather than failing inbound processing or dropping the conversation.

#### Scenario: Missing storage does not break inbound handling
- **WHEN** object storage is disabled in a dev environment and a media message arrives
- **THEN** the inbound text is still processed, a warning is logged, and the conversation is not moved to a failed state

#### Scenario: Storage enabled in CI uses local-compatible endpoint
- **WHEN** integration tests run with the storage flag on
- **THEN** assets are written to and read back from the configured S3-compatible endpoint (e.g. MinIO from compose)
