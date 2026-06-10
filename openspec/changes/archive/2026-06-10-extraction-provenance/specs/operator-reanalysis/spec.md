## MODIFIED Requirements

### Requirement: Operator re-run with supersede

`POST /conversations/:id/messages/:mid/reanalyze` SHALL enqueue profile-extract for that inbound message with `supersede: true`. Supersede SHALL mark the prior `(profileId, sourceMessageId)` rows as superseded instead of deleting them: `placement.offer` rows and legacy `rate.*`/`audience.*`/other data points get `superseded_at`, attribute proposals in status `proposed` move to status `superseded` (keeping their evidence and rationale), and the prior `raw_payload` media-asset row for that message is replaced as before. The marking SHALL happen only AFTER both extractors return successfully, INSIDE the write transaction and immediately before the fresh create loop, so a failed re-extraction never loses or hides the old data. The marking SHALL NOT touch operator-origin points (`sourceMessageId=null`, `extractedBy='operator'`) nor admin-approved `active` attribute rows. The idempotency check for the fresh rows SHALL consider only live rows so the re-extraction's writes are not skipped as duplicates. The profile SHALL be re-rolled after. Only operators/admins may call it.

#### Scenario: Re-run replaces stale rows without destroying them

- **WHEN** an operator re-runs analysis on a message whose prior extraction was wrong
- **THEN** the prior rows for that message are marked superseded, the fresh extraction's rows take their place in all default reads (not duplicated, not skipped), and the superseded rows remain retrievable for audit

#### Scenario: Re-run picks up a new hint

- **WHEN** an operator adds an extraction hint for the channel and re-runs a message
- **THEN** the extractor receives the hint and the re-run can produce the corrected facts

#### Scenario: Superseded proposals are history, not noise

- **WHEN** a re-run supersedes a message's pending attribute proposals
- **THEN** they appear only in the review UI's collapsed history section and are no longer actionable
