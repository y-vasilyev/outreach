## ADDED Requirements

### Requirement: Profile-extract is observable, supersedable, and hint-aware

The profile-extract worker SHALL stamp `Message.extractionStatus` on every terminal outcome (`failed` only on sync-catch / final retry exhaustion), SHALL honor a `supersede` job flag (after both extractors succeed, delete prior `(profileId, sourceMessageId)` rows — incl. the `raw_payload` media-asset row — inside the write transaction before the fresh writes), and SHALL load operator hints applicable to the conversation/channel and pass them to the extractor agents. These behaviors SHALL be additive: when no hint exists and `supersede` is absent, extraction behavior is unchanged except for the status stamp.

#### Scenario: Status stamped without changing extraction output

- **WHEN** a normal inbound is extracted with no operator action
- **THEN** the data written is the same as before AND the message is stamped `ok`/`empty`/`no_signal` accordingly

#### Scenario: Supersede is idempotent-safe

- **WHEN** `supersede` re-run is invoked twice in a row
- **THEN** the second run deletes the first run's rows and re-writes, leaving exactly one set of rows for that message (no accumulation)
