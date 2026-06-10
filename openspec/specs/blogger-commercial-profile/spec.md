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

Each harvested fact SHALL be stored as a `profile_data_point` `{ profile_id, field, value, unit?, confidence, extracted_by, source_message_id, agent_run_id?, raw_snippet, captured_at, superseded_at? }`. The verbatim source text SHALL be preserved in `raw_snippet` (and the original message retained), so the rolled-up profile can be re-derived and audited. LLM-extracted points SHALL carry the `agent_run_id` of the extractor run that produced them (operator-origin points keep it null), so any fact is traceable to the exact model/config/cost that emitted it; the id SHALL be the persisted `agent_run.id` (never a dangling identifier) and SHALL be null when run persistence failed. Data points SHALL never be physically deleted by extraction flows: replacement marks the prior row with `superseded_at`. Default readers (roll-up, HUD, idempotency checks, profile read API) SHALL consider only live rows (`superseded_at IS NULL`); superseded rows SHALL remain retrievable on demand (`includeSuperseded=true` on the profile read, returning `superseded_at` and `agent_run_id`).

#### Scenario: Raw reply text is preserved alongside the parsed value

- **WHEN** an extractor parses "охваты сторис ~12к, пост 25к" into reach data points
- **THEN** each resulting `profile_data_point` stores the parsed numeric value plus the original snippet and a confidence

#### Scenario: Profile roll-up is deterministic from data points

- **WHEN** multiple data points exist for the same field
- **THEN** the `blogger_profile` field is composed deterministically (e.g. latest high-confidence value) from live rows and the contributing data points remain individually retrievable

#### Scenario: Fact traceable to its agent run

- **WHEN** an operator questions a wrong price extracted last week
- **THEN** the data point's `agent_run_id` identifies the exact extractor run (model, config version, tokens) that produced it

#### Scenario: Superseded facts are excluded by default but auditable

- **WHEN** a message was re-analyzed and its prior points superseded
- **THEN** roll-up and HUD reflect only the fresh points, while `includeSuperseded=true` returns both generations with their timestamps

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

### Requirement: Public post insights attached to blogger profiles

The system SHALL store normalized public post insight rows for blogger profiles. Each row SHALL preserve public post identity, platform, URL when available, publish time, text snippet, media kind, source, metric capture time, and the metrics available from that source. Metrics MAY include views, likes, comments, shares, forwards, reactions, saves, and engagement rate. Missing metrics SHALL remain absent/null and MUST NOT be inferred from unrelated fields.

#### Scenario: ScrapeCreators post metrics are stored
- **WHEN** ScrapeCreators returns public Instagram or YouTube posts for a profile with metric fields available in the raw response
- **THEN** the worker normalizes those metrics into post insight rows linked to the blogger profile and preserves the capture timestamp/source

#### Scenario: Telegram public post metrics are stored
- **WHEN** Telegram public channel parsing yields a public post id, date, text, and metrics such as views, forwards, or reactions
- **THEN** the worker upserts a post insight row linked to the blogger profile and marks the source as Telegram public parsing

#### Scenario: Source lacks metrics
- **WHEN** a public post source provides text/date but no reliable metric values
- **THEN** the post insight row is stored with empty metrics rather than fabricating views, likes, or engagement

#### Scenario: Raw upstream payload is not exposed in profile API
- **WHEN** a profile detail response includes post insights
- **THEN** it exposes normalized public fields and provenance only, and does not include ScrapeCreators API keys, encrypted integration config, raw hidden data, or full upstream payloads

### Requirement: Profile APIs expose top post insights

The blogger profile list and detail APIs SHALL expose post insight data in bounded form. List responses SHALL include a compact `topPostsPreview` capped to a small number per profile. Detail responses SHALL include a larger `postInsights` collection with sorting metadata, metrics, freshness, and provenance. Existing profile fields SHALL remain backward compatible.

#### Scenario: List response includes bounded preview
- **WHEN** the catalog list API returns profiles with post insight rows
- **THEN** each profile item includes at most the configured preview count of top posts and does not include unbounded raw post history

#### Scenario: Detail response includes auditable post insights
- **WHEN** an operator opens a blogger profile detail page
- **THEN** the response includes post insights with post identity, metric values, metric freshness, source, and capture time

#### Scenario: Legacy profile without post insights remains readable
- **WHEN** a pre-existing profile has no post insight rows
- **THEN** the list and detail APIs still serialize successfully with empty post insight arrays

### Requirement: Post insight freshness is independent of profile freshness

Post insight metric freshness SHALL be calculated from each post insight's `metricCapturedAt` and SHALL NOT reuse profile-level `capturedAt` or commercial profile section freshness. The API SHALL expose whether post metrics are fresh, stale, unavailable, or pending refresh.

#### Scenario: Fresh post metrics are marked fresh
- **WHEN** a post insight has metrics captured within the configured post-metric TTL
- **THEN** the API marks that post's metric freshness as fresh and includes the age in days

#### Scenario: Stale post metrics are marked stale
- **WHEN** a post insight's metrics were captured before the configured TTL
- **THEN** the API marks that post's metric freshness as stale even if the profile's rate cards or audience sections are fresh

#### Scenario: Missing metric timestamp is unavailable
- **WHEN** a post insight has no metric capture timestamp or no numeric metrics
- **THEN** the API reports metric freshness as unavailable rather than fresh

### Requirement: Blogger profile surfaces structured placement offers
The blogger profile read API SHALL include `placementOffers` alongside legacy `rateCards`. Each placement offer SHALL expose typed attributes, price/currency, confidence, source message id, raw snippet, and captured timestamp. Existing `rateCards` and `formats` SHALL continue to be present and SHALL be derived from placement offers when structured data exists.

#### Scenario: Profile detail includes offer attributes
- **WHEN** a profile contains a Telegram post offer for one month and an offsite review offer
- **THEN** the profile detail response includes both structured offers with their attributes and also includes compatibility `rateCards`

#### Scenario: Legacy rows are repaired from source message
- **WHEN** a profile only has generic legacy rows but their source message can be loaded
- **THEN** the read service derives structured placement offers from the source message and uses them to produce non-collapsed compatibility rate cards

### Requirement: Placement offer provenance is auditable
Each placement offer and attribute SHALL retain source provenance back to the original message/media-kit payload and the extractor run. The raw text fragment used for the offer or attribute SHALL be available in the profile detail response.

#### Scenario: Operator audits extracted duration
- **WHEN** an operator opens a placement offer with `duration=month`
- **THEN** the UI can show the raw snippet containing "пост на месяц 21000" and link back to the source message

### Requirement: Profile freshness includes placement offers
The profile freshness signal SHALL classify usable structured placement offers as contributing to the `rateCards` and `formats` freshness sections. Missing or inactive attribute proposals SHALL NOT mark a placement target as complete.

#### Scenario: Fresh structured offer updates rate-card freshness
- **WHEN** a placement offer with a usable price was captured within the rate-card TTL
- **THEN** `freshness.rateCards` and `freshness.formats` are fresh even if no legacy `rate.<format>` data point was written directly

#### Scenario: Proposed attribute does not complete active profile field
- **WHEN** an extractor proposes an inactive attribute for an offer
- **THEN** the profile may show the proposal for review, but the attribute is not counted as collected until activation

### Requirement: placementOffers always populated from data points

`BloggerProfile.placementOffers` SHALL be populated from the profile's `placement.offer` data points on every roll-up, regardless of feature-flag state, so the catalog is structurally complete. The rolled-up `placementOffers` AND the legacy `rateCards`/`formats` derived for compatibility SHALL both apply the confidence-floor rule (facts below the configurable floor are excluded from these comparable views but retained as data points). Legacy `rateCards`/`formats` SHALL remain derived for compatibility above the floor.

#### Scenario: Profile exposes offers independent of flag

- **WHEN** a profile has confident `placement.offer` data points
- **THEN** the profile read response includes them in `placementOffers` whether or not `structured_placement_offers` is on

#### Scenario: Low-confidence offer excluded from comparable list but retained

- **WHEN** a profile has a `placement.offer` data point below the confidence floor
- **THEN** it is absent from `placementOffers` but still present (flagged needs-review) in the `dataPoints` provenance array

### Requirement: Profile exposes platformAudience and v2 placement terms

The blogger profile read API SHALL include `platformAudience` and SHALL preserve the v2 placement attributes (`price_period`, `prepayment`, `tax_regime`, `tax_included`, `tariff_name`, `slot`, `top_pin_hours`, `package_items`, `package_price`) on each offer, so operators and the compare view can inspect them without parsing free text. Legacy `reach`/`avgViews`/`audience`/`rateCards` SHALL remain populated and unchanged.

#### Scenario: Read API returns per-platform audience

- **WHEN** a profile has `platformAudience` entries
- **THEN** the profile detail response includes them alongside the legacy scalar `reach`

#### Scenario: v2 attributes survive the roll-up onto the read model

- **WHEN** an offer carries `price_period`/`prepayment`/`tax_regime`
- **THEN** those attributes appear on the offer in the profile read response

### Requirement: Rolled-up placement offers compose from offer rows

`BloggerProfile.placementOffers` SHALL be composed from `active` `placement_offer` rows, producing output byte-compatible with the legacy compose-from-data-points path (same shape, ordering, confidence floor). The rows path SHALL be used only when rows fully cover the profile's `placement.offer` data points; with no rows yet (pre-backfill window, dual-write incident override) or PARTIAL coverage (interrupted backfill, operator-created offer points), composition SHALL fall back to the legacy data-point path — never silently dropping uncovered offers — and log which source was used. Every profile re-roll path (extraction worker, operator markup edits) SHALL use this same rows-aware composition so superseded prices cannot resurface via a legacy re-roll.

#### Scenario: Catalog reads are unchanged after the switch

- **WHEN** the same extraction history is composed via offer rows and via the legacy data-point path
- **THEN** the resulting `placementOffers` arrays are equal (verified on the real failing-reply fixtures)

#### Scenario: Fallback before backfill

- **WHEN** a profile has `placement.offer` data points but no `placement_offer` rows
- **THEN** the roll-up composes from data points and records the fallback source

### Requirement: Profile read API exposes offer history

`GET /blogger-profiles/:id` SHALL expose, per offer identity, the `active` row id and its superseded chain (prior prices with `capturedAt` and provenance references), so an operator can see how a blogger's pricing changed over time without reading raw messages.

#### Scenario: Price history visible on the profile

- **WHEN** an offer was superseded twice by price updates
- **THEN** the profile response lists the active offer plus its two prior prices in reverse-chronological order with their captured timestamps

