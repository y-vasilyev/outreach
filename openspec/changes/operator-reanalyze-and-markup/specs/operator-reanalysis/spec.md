## ADDED Requirements

### Requirement: Per-message extraction status

Every inbound message the profile-extract pipeline considers SHALL carry an `extractionStatus` ∈ {`pending`, `ok`, `empty`, `no_signal`, `failed`}, plus `extractionError` and `extractedAt`. The worker SHALL stamp `no_signal` when the pre-gate skips, `empty` when extraction returned zero facts, and `ok` on a successful write. `failed` SHALL be stamped ONLY on a terminal failure — the synchronous `handleOnInbound` catch, or final BullMQ retry exhaustion — NOT on every throw, so a message awaiting an automatic retry is not falsely shown as terminally failed (it stays `pending` between attempts). A status change SHALL be observable by the operator UI without manual refresh (a realtime event or the route response). The message read API SHALL surface these fields.

#### Scenario: Failed extraction is visible

- **WHEN** both extractors fail for an inbound message
- **THEN** that message's `extractionStatus` is `failed` with an `extractionError`, visible in the inbox

#### Scenario: Empty extraction is distinguishable from success

- **WHEN** an inbound carries commercial signal but yields no data points
- **THEN** its status is `empty` (not `ok`), so the operator can choose to re-run or add a hint

### Requirement: Operator re-run with supersede

`POST /conversations/:id/messages/:mid/reanalyze` SHALL enqueue profile-extract for that inbound message with `supersede: true`. Supersede SHALL delete the prior `(profileId, sourceMessageId)` rows — `placement.offer` rows, legacy `rate.*`/`audience.*`/other data points, attribute proposals, AND the prior `raw_payload` media-asset row for that message — only AFTER both extractors return successfully, INSIDE the write transaction and immediately before the fresh create loop. (Deleting before extraction would lose the old data if the re-extraction failed; the deletes therefore live in the same transaction as the re-roll.) The deletes SHALL NOT touch operator-origin points (`sourceMessageId=null`, `extractedBy='operator'`). The profile SHALL be re-rolled after. Only operators/admins may call it.

#### Scenario: Re-run replaces stale rows

- **WHEN** an operator re-runs analysis on a message whose prior extraction was wrong
- **THEN** the prior rows for that message are removed and the fresh extraction's rows take their place (not duplicated, not skipped)

#### Scenario: Re-run picks up a new hint

- **WHEN** an operator adds an extraction hint for the channel and re-runs a message
- **THEN** the extractor receives the hint and the re-run can produce the corrected facts
