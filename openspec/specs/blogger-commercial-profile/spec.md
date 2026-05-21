## Purpose

A standardized, queryable `blogger_profile` per channel — topics, audience demographics, reach/views, languages, formats with rate cards — backed by granular `profile_data_point` records that preserve provenance and raw text. Extractor agents (`RateCardExtractor`, `AudienceStatsExtractor`) map free-text replies to confidence-scored data points so the profile can be re-derived and audited.

## Requirements

### Requirement: Standardized blogger profile

The system SHALL maintain a `blogger_profile` per blogger/channel holding standardized, queryable fields: topics, audience demographics (age, gender, geo distribution), reach / average views, languages, and formats offered with their rate cards. The profile SHALL carry `captured_at` provenance so freshness can be assessed later.

#### Scenario: Profile is created/updated from a conversation
- **WHEN** extraction completes for an `agency_sourcing` conversation that yielded pricing and audience data
- **THEN** a `blogger_profile` for the linked channel is created or updated with the standardized fields and a `captured_at` timestamp

#### Scenario: Profile is queryable for matching
- **WHEN** a query filters profiles by topic and geo
- **THEN** profiles whose standardized fields satisfy the filter are returned without parsing raw message text at query time

### Requirement: Granular data points preserve provenance and raw text

Each harvested fact SHALL be stored as a `profile_data_point` `{ profile_id, field, value, unit?, confidence, extracted_by, source_message_id, raw_snippet, captured_at }`. The verbatim source text SHALL be preserved in `raw_snippet` (and the original message retained), so the rolled-up profile can be re-derived and audited.

#### Scenario: Raw reply text is preserved alongside the parsed value
- **WHEN** an extractor parses "охваты сторис ~12к, пост 25к" into reach data points
- **THEN** each resulting `profile_data_point` stores the parsed numeric value plus the original snippet and a confidence

#### Scenario: Profile roll-up is deterministic from data points
- **WHEN** multiple data points exist for the same field
- **THEN** the `blogger_profile` field is composed deterministically (e.g. latest high-confidence value) and the contributing data points remain individually retrievable

### Requirement: Extractor agents map free-text replies to data points

The system SHALL include `RateCardExtractor` and `AudienceStatsExtractor` agents that read a blogger's free-text replies (and structured snapshots) and emit `profile_data_point` records with confidence. Extraction SHALL run via `AgentRunner` and write `agent_run`.

#### Scenario: Rate card extraction
- **WHEN** a blogger sends prices per format ("сторис 8000, пост 15000")
- **THEN** `RateCardExtractor` emits per-format rate data points with units and confidence, and an `agent_run` row is written

#### Scenario: Low-confidence extractions are flagged not dropped silently
- **WHEN** an extractor is unsure whether a number is reach or subscriber count
- **THEN** it emits the data point with low confidence and a rationale rather than discarding it, so an operator can review
