## Purpose

The conversation pipeline for `agency_sourcing` campaigns: an agency-framed opening that cites a concrete observed integration in the blogger's posts, a `DataCollectionPlanner` that elicits target data points one topic at a time, and a commercial-language safety profile that permits ad vocabulary while still blocking guarantees, fabricated client specifics, money transfers, and forcing operator handoff on price commitments.
## Requirements
### Requirement: Agency-framed opening referencing the blogger's ad

For campaigns of type `agency_sourcing`, the system SHALL compose an opening message that presents the sender as a media-buying agency and references a concrete ad/integration observed in the blogger's own posts, framed as having a client interested in a similar placement. The opening SHALL ask to open a commercial conversation (price, formats, timelines) without committing to terms.

#### Scenario: Opening cites an observed ad
- **WHEN** the agency opening composer runs for a channel whose recent posts contain an identifiable sponsored integration
- **THEN** the generated opening references that integration as the hook and frames the message as an agency with a client seeking a similar placement

#### Scenario: Opening does not invent placements
- **WHEN** no sponsored integration can be identified in the channel's posts
- **THEN** the composer either uses the channel's topic as a generic agency hook or returns no auto-send-eligible variant, and SHALL NOT fabricate a specific past ad

### Requirement: Data-collection dialogue planner

For `agency_sourcing` conversations, the inbound pipeline SHALL run a `DataCollectionPlanner` that tracks which target data points (rate card per format, reach/views, audience demographics, geo, contact for deals) are still missing and proposes the next question to elicit them, one topic at a time.

#### Scenario: Planner asks for the next missing data point
- **WHEN** the blogger has shared pricing but not audience demographics
- **THEN** the planner proposes a reply that requests audience demographics and does not re-ask for pricing

#### Scenario: Planner stops when targets are collected
- **WHEN** all target data points for the campaign have been collected
- **THEN** the planner proposes a closing/thank-you reply and marks the conversation goal as satisfied

### Requirement: Commercial-language safety profile

The `agency_sourcing` safety profile SHALL permit commercial vocabulary (e.g. "реклама", "интеграция", "прайс", "охваты") while still blocking: guarantees of results, fabricated client specifics, transfers of money or payment links, and pressure tactics. Intents indicating price agreement or sending a quote SHALL force operator handoff so a human confirms commercial terms.

For the categories that MUST be blocked (guarantees, payment/transfer references, time-pressure tactics, etc.), the safety profile SHALL provide a list of deterministic `hard_block_patterns` (regex with a human-readable `reason` per pattern), and `SafetyFilter` SHALL reject any draft whose text matches at least one of those patterns BEFORE invoking its LLM scoring step. The LLM step remains advisory (`allow=true`, scored via `risk_score`); only the deterministic and configurable hard-block layer can set `allow=false` for the topical categories named above.

#### Scenario: Commercial vocabulary passes safety

- **WHEN** an agency-mode draft mentions "интеграция" and asks for the blogger's "прайс"
- **THEN** `SafetyFilter` does not block the draft on vocabulary grounds

#### Scenario: Price commitment forces handoff

- **WHEN** the blogger states a price and the intent classifier flags a price-agreement/quote intent
- **THEN** the conversation is set to `operator_now`/`manual` and no auto-send occurs for that turn

#### Scenario: Result guarantees are still blocked

- **WHEN** an agency-mode draft promises a specific result (e.g. guaranteed sales or views)
- **THEN** `SafetyFilter` blocks the draft and supplies a rewrite hint

#### Scenario: Hard-block pattern fires before LLM scoring

- **WHEN** an agency-mode draft text matches one of the profile's `hard_block_patterns` (e.g. `гарантиру[а-я]*`)
- **THEN** `SafetyFilter` returns `allow=false` with `risk_score=1`, the matched pattern's `id` and `reason` in `reasons[]`, and a `rewrite_hint`, WITHOUT consulting the LLM scoring step

#### Scenario: Malformed stored pattern is skipped by the resolver, not fatal

- **WHEN** the stored `safetyProfile` contains a `hard_block_patterns` entry that fails schema validation (e.g. `id`/`pattern`/`reason` length violation, illegal `flags`) or whose `pattern` fails to compile as a regex
- **THEN** the resolver SHALL silently drop that single entry and proceed with the remaining valid patterns and the rest of the safety profile (`max_length`, `allow_links`, `forbidden_topics`, `allowed_topics`) intact; it MUST NOT raise an error, return `LEGACY_SAFETY_CONTEXT`, or block the pipeline

#### Scenario: Direct SafetyFilter input is schema-validated, with compile-error fallback

- **WHEN** `SafetyFilter` is invoked directly (e.g. via tests or admin dry-runs) with an `hard_block_patterns` array
- **THEN** the input SHALL be validated against the same `HardBlockPatternZ` bounds; schema-invalid entries cause input validation to fail (callers see a parse error). For entries that pass schema validation but fail run-time `new RegExp(...)` compilation, `SafetyFilter` SHALL silently drop the broken entry (defense-in-depth) and continue evaluating the rest of the list, never throwing.

#### Scenario: Base safety profile survives a bad hard-block entry

- **WHEN** the stored `safetyProfile` has a syntactically wrong `hard_block_patterns[0]` (missing `id`, `pattern` over the 200-char cap, illegal `flags`) but the base fields (`max_length`, `allow_links`, `forbidden_topics`, `allowed_topics`) are valid
- **THEN** the resolver SHALL return the valid base fields and the surviving valid `hard_block_patterns` entries; it MUST NOT fall back to `LEGACY_SAFETY_CONTEXT` and lose unrelated safety configuration

#### Scenario: Empty hard_block_patterns is a no-op

- **WHEN** the resolved safety context contains `hard_block_patterns = []` (e.g. a `custdev` campaign, a typeless campaign, or a flag-off rollout)
- **THEN** the SafetyFilter hard-block branch is a no-op and behavior is identical to the pre-change advisory-only flow

### Requirement: Agency inbound extraction creates placement offers
For `agency_sourcing` conversations, the inbound profile extraction path SHALL create structured placement offers from blogger replies and media-kit text when prices or commercial placement terms are present. The pipeline SHALL preserve low-confidence offers for operator review rather than silently dropping commercially relevant facts.

#### Scenario: Inline terms are extracted during inbound processing
- **WHEN** the latest inbound contains inline pricing such as "пост на сутки 13000, пост на месяц 21000"
- **THEN** the profile extraction pipeline creates separate structured placement offers and persists provenance to the source message

#### Scenario: Ambiguous package is kept for review
- **WHEN** the extractor cannot determine whether a price is for one format or a package
- **THEN** it emits a low-confidence package or unknown-kind offer with raw evidence instead of discarding the price

### Requirement: Planner asks for missing placement attributes
The `DataCollectionPlanner` SHALL receive known placement offers and active required attributes for the campaign. If an offer is missing a required attribute, the planner SHALL ask a focused follow-up about that attribute rather than re-asking for the whole rate card.

#### Scenario: Planner asks for deletion policy
- **WHEN** the blogger shared a post price but the active campaign target requires deletion policy and no `delete_policy` attribute is known
- **THEN** the planner asks whether the post is deleted after a fixed period or remains permanently

#### Scenario: Planner does not re-ask collected price
- **WHEN** an offer already has a usable price and currency
- **THEN** the planner SHALL NOT ask for price again unless the price is stale, low-confidence, or contradicted by newer evidence

### Requirement: Attribute proposals are routed to operator review
When extraction produces inactive attribute proposals, the agency pipeline SHALL surface them to the operator/admin review path without sending them to the contact and without treating them as completed data-collection targets.

#### Scenario: Proposed attribute is operator-only
- **WHEN** the extractor proposes a new attribute from a blogger reply
- **THEN** the proposal is visible to operators/admins for review and no outbound message mentions internal schema or attribute creation

### Requirement: Structured placement offers are the canonical write path

For `agency_sourcing` conversations, the inbound profile-extract pipeline SHALL **always** persist structured `placement.offer` data points, `placement_attribute` proposals, and roll them up onto `BloggerProfile.placementOffers`, independent of any feature flag. The `structured_placement_offers` feature flag SHALL govern only downstream **matching and data-collection-planner preference** (whether fit-scoring and the planner prefer structured offers over legacy `rate.<format>` cards) — it SHALL NOT gate whether structured offers are persisted, rolled up, or exposed by the profile read API (which already returns `placementOffers` unconditionally). Legacy `rate.<format>` data points SHALL continue to be derived for compatibility.

#### Scenario: Offers persisted and exposed with flag off

- **WHEN** an inbound reply yields placement offers and `structured_placement_offers` is off
- **THEN** the `placement.offer` data points and attribute proposals are persisted, `BloggerProfile.placementOffers` is rolled up, and the profile read API exposes them — while fit-scoring and the planner still use the legacy path

#### Scenario: Flag governs matching/planner preference only

- **WHEN** `structured_placement_offers` is turned on
- **THEN** fit-scoring and the planner prefer the already-persisted structured offers; turning the flag on does not require re-running extraction to populate them

### Requirement: Deterministic parser covers common Russian reply layouts

The deterministic placement-offer parser SHALL, without any schema change, recognise: a `млн`/`млрд` price multiplier; the platforms `МАХ`/MAX, `Дзен`/Zen, and `ТГК` (mapped to the promoted `platform` field as `max`/`zen`/`telegram`); comma-separated per-format price pairs on a single line; and placement-duration ladders (`час топа`/`72ч`) as separate offers whose precise tier is preserved in the free-form `notes` attribute when it does not fit the existing duration values.

#### Scenario: Millions parsed in audience/price prose

- **WHEN** a reply contains `"1.2млн"`
- **THEN** the parser yields the numeric value `1200000`, not `1.2`

#### Scenario: Non-enum platforms preserved

- **WHEN** a reply prices placements on `ТГК` and `МАХ`
- **THEN** the offers carry `platform = "telegram"` and `platform = "max"` respectively, instead of dropping the second platform

#### Scenario: Comma-separated per-format pair on one line

- **WHEN** a line reads `"Фото-пост 120000, Видео-пост 170000"`
- **THEN** the parser yields two offers, one per format with its own price

#### Scenario: Duration ladder preserved in notes

- **WHEN** a line reads `"Час топа/24ч 6000, /72ч 9000, /месяц 12000"`
- **THEN** the parser yields three offers and the `72ч` tier is preserved (e.g. in a `notes` attribute) rather than discarded

### Requirement: Profile-extract is observable, supersedable, and hint-aware

The profile-extract worker SHALL stamp `Message.extractionStatus` on every terminal outcome (`failed` only on sync-catch / final retry exhaustion), SHALL honor a `supersede` job flag (after both extractors succeed, delete prior `(profileId, sourceMessageId)` rows — incl. the `raw_payload` media-asset row — inside the write transaction before the fresh writes), and SHALL load operator hints applicable to the conversation/channel and pass them to the extractor agents. These behaviors SHALL be additive: when no hint exists and `supersede` is absent, extraction behavior is unchanged except for the status stamp.

#### Scenario: Status stamped without changing extraction output

- **WHEN** a normal inbound is extracted with no operator action
- **THEN** the data written is the same as before AND the message is stamped `ok`/`empty`/`no_signal` accordingly

#### Scenario: Supersede is idempotent-safe

- **WHEN** `supersede` re-run is invoked twice in a row
- **THEN** the second run deletes the first run's rows and re-writes, leaving exactly one set of rows for that message (no accumulation)

