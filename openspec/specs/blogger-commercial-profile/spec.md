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

### Requirement: Profile read API surfaces per-section observation freshness

The blogger profile read API SHALL include a `freshness` object on the profile detail response that reports per-section *observation freshness* for the rolled-up fields. Each section (`rateCards`, `audience`, `topics`, `languages`, `formats`, `reach`, `avgViews`) SHALL carry `{ stale: boolean, ageDays: number | null }`. A section's timestamp SHALL come from the newest data point that both (a) classifies to that category and (b) whose value would be picked up by the profile roll-up's value filters. If no such point exists the section SHALL be reported `{ stale: true, ageDays: null }` — there is no fallback to a profile-level timestamp. Usable `rate.<format>` points SHALL count toward `formats` freshness in addition to `rateCards`, mirroring how the rolled-up `formats` union derives from rate cards. The TTLs SHALL be category-specific (rate cards / reach / average views: 90 days; audience: 180 days; topics / languages / formats: 365 days) and SHALL live in shared code so workers and UI can call the same classifier.

The signal is observation freshness, NOT the age of the displayed rolled-up value. The roll-up's confidence-band-then-recency arbitration can pick an older high-confidence value over a newer low-confidence one, so a section can be reported fresh even when the displayed value is older. The `dataPoints` array on the same response provides the per-point provenance operators need to audit which observation the roll-up chose.

#### Scenario: Fresh rate card section
- **WHEN** the profile has a numeric `rate.<format>` data point captured within the rate-card TTL
- **THEN** `freshness.rateCards` is `{ stale: false, ageDays: <days since that point> }`

#### Scenario: Stale rate card section
- **WHEN** the most recent contributing `rate.*` data point was captured longer ago than the rate-card TTL
- **THEN** `freshness.rateCards.stale` is `true` and `ageDays` reflects that age

#### Scenario: Fresh non-contributing point does not mark a section fresh
- **WHEN** a fresh `rate.post` data point has a non-numeric value (e.g. "договорная") and the only contributing rate-card point is older than the TTL
- **THEN** `freshness.rateCards.stale` is `true` and `ageDays` reflects the older contributing point's age, so the signal matches what the rolled-up rate cards actually show

#### Scenario: Section with no contributing data points is stale-by-default
- **WHEN** a section (e.g. `topics`) has no data point that classifies to it and contributes to the rolled-up view
- **THEN** the section is reported as `{ stale: true, ageDays: null }` so the operator sees a warning rather than a silent gap, even if other sections have fresh points

#### Scenario: Rate card observations contribute to formats freshness
- **WHEN** a profile has a usable `rate.<format>` data point but no explicit `formats|format` data point
- **THEN** `freshness.formats` follows the rate card's age, matching the rolled-up `formats` union which derives from rate cards

#### Scenario: Unrendered audience sub-dims do not affect audience freshness
- **WHEN** a profile has a usable `audience.income` data point but no `audience.geo|age|gender` points
- **THEN** `freshness.audience` is `{ stale: true, ageDays: null }`, because the rolled-up audience view only renders `geo`/`age`/`gender`

