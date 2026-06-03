## MODIFIED Requirements

### Requirement: Agency-framed opening referencing the blogger's ad

For campaigns of type `agency_sourcing`, the system SHALL compose an opening message that presents the sender as a media-buying agency and references a concrete ad/integration observed in the blogger's own posts, framed as having a client interested in a similar placement. The opening SHALL ask to open a commercial conversation (price, formats, timelines) without committing to terms.

The `observed_integrations` input to `agency_opening_composer` SHALL be sourced ONLY from the `sponsored_integration_detector` (see `sponsored-integration-detection` capability), filtered by a configurable minimum confidence. Raw `channel.rawData.posts` SHALL NOT be passed in directly.

The worker auto-send-loop (dispatcher first-message + `handleOutreachFirstMessage` in `agent-run`) SHALL respect each variant's `auto_send_eligible` field. Variants with `auto_send_eligible === false` SHALL be saved as `pending` suggestions but SHALL NOT participate in auto-approve regardless of their safety score. CustDev's `OpeningComposer`, which does not emit this field, SHALL continue to be treated as eligible (`undefined ≡ true`).

The `client_brief` field passed into `agency_opening_composer` SHALL be sourced from `campaign.goal.client_brief` when present; `campaign.valueProp` SHALL be used only as a fallback for campaigns that predate `goal.client_brief`.

#### Scenario: Opening cites a detector-confirmed integration
- **WHEN** the agency opening composer runs for a channel whose `sponsored_integration_detector` returned at least one integration above the minimum confidence
- **THEN** the generated opening references that integration as the hook and frames the message as an agency with a client seeking a similar placement

#### Scenario: Opening does not invent placements
- **WHEN** the `sponsored_integration_detector` returns zero integrations above the configured minimum confidence
- **THEN** the composer either uses the channel's topic as a generic agency hook or returns no auto-send-eligible variant, and SHALL NOT fabricate a specific past ad

#### Scenario: Non-eligible variant is not auto-sent even when safety passes
- **WHEN** an agency opener variant has `auto_send_eligible = false` and a high safety pass score
- **THEN** the worker persists the variant as a `pending` Suggestion but does NOT auto-approve or send it; the operator must approve it manually

#### Scenario: client_brief is taken from goal, not valueProp
- **WHEN** an `agency_sourcing` campaign has both `goal.client_brief = "B2B SaaS лиды"` and `valueProp = "что-то старое"`
- **THEN** the composer input's `campaign.client_brief` is `"B2B SaaS лиды"`; the legacy `valueProp` is not used

### Requirement: Data-collection dialogue planner

For `agency_sourcing` conversations, the inbound pipeline SHALL run a `DataCollectionPlanner` that tracks which target data points are still missing and proposes the next question to elicit them, one topic at a time.

Before invoking the planner on an inbound, the pipeline SHALL execute `handleProfileExtract` synchronously for the triggering inbound message so that the planner's view of "already collected" reflects facts present in THAT inbound. The planner SHALL NOT operate on a pre-extraction snapshot of the blogger profile when the current inbound carries commercial data.

The default agency target keyword mapping SHALL distinguish `audience_demographics` (matching only `audience.age` and `audience.gender` fields) from `geo` (matching `audience.geo` only). A campaign that targets both SHALL NOT have one marked collected when only the other has a data point.

`AGENCY_DEFAULT_TARGETS` SHALL NOT include `deals_contact` unless a corresponding extractor is registered. When operators explicitly add `deals_contact` to a campaign's `target_data_points`, the planner SHALL still ask the question but SHALL surface it as a known limitation (no automated capture path yet).

#### Scenario: Planner sees freshly-arrived data on the same inbound
- **WHEN** a blogger replies with their full price list on inbound message M
- **THEN** during M's `on_inbound` processing the pipeline first runs `handleProfileExtract({sourceMessageId: M.id})` and then `DataCollectionPlanner` reads the just-persisted rate data points, so the planner asks for the next missing target (e.g. reach) rather than re-asking for the price

#### Scenario: Audience demographics is not marked collected when only geo is known
- **WHEN** a profile has a single `audience.geo` data point and the campaign targets both `audience_demographics` and `geo`
- **THEN** the planner marks `geo` collected, leaves `audience_demographics` uncollected, and the next question targets demographics

#### Scenario: deals_contact removed from defaults
- **WHEN** no `deals_contact_extractor` is registered and a campaign uses `AGENCY_DEFAULT_TARGETS`
- **THEN** `deals_contact` is NOT in the planner's `target_data_points`, so the planner does not re-ask about a contact for deals indefinitely

#### Scenario: Planner stops when targets are collected
- **WHEN** all target data points for the campaign have been collected
- **THEN** the planner proposes a closing/thank-you reply and marks the conversation goal as satisfied

## ADDED Requirements

### Requirement: Fail-fast on agency campaigns with the flag off

When the `agency_sourcing` feature flag is off, the API SHALL reject campaign create/update requests that set `type.key === 'agency_sourcing'` with a 422 error code `AGENCY_SOURCING_DISABLED`. For campaigns already in the database with this type but the flag off, the dispatcher and inbound pipeline SHALL log a warn-level diagnostic on each tick rather than silently degrading to the CustDev path.

#### Scenario: Create rejected when flag is off
- **WHEN** an operator POSTs a campaign with `type.key = 'agency_sourcing'` while the flag is off
- **THEN** the API responds 422 `AGENCY_SOURCING_DISABLED` and nothing is persisted

#### Scenario: Diagnostic logged for pre-existing campaign under flag-off
- **WHEN** the dispatcher tick reaches an `agency_sourcing` campaign and the flag is off
- **THEN** a warn log with `{ campaignId, reason: 'agency_sourcing_disabled' }` is emitted, and the campaign is skipped — NOT silently routed through CustDev opener/safety

### Requirement: Extractor pre-gate skips inbounds with no commercial signal

`handleProfileExtract` SHALL detect inbounds with no commercial signal (no digits AND no commercial format/audience keyword) and SHALL skip both extractor LLM calls for such turns, returning `{ ok: true, skipped: 'no_signal' }`. The detector is deterministic, fast, and intended only as a cost gate — not as a content classifier.

#### Scenario: "ок, давай в пятницу" skipped
- **WHEN** the triggering inbound text contains no digits and no commercial keyword (`пост|сторис|reels|охват|просмотр|подписчик|рекламн|интеграц|прайс|цена|руб|₽|тыс|млн|k|usd|eur`)
- **THEN** the extractors are not invoked; the worker returns `{ ok: true, skipped: 'no_signal' }`

#### Scenario: "пост 15000" passes the gate
- **WHEN** the triggering inbound contains a number and a format keyword
- **THEN** the gate passes and both extractor agents are invoked normally

### Requirement: profile-extract distinguishes empty result from failure

`handleProfileExtract` SHALL distinguish two cases:
1. Both extractors returned (possibly with empty `data_points`) — the job completes successfully (`{ ok: true, dataPoints: N, degraded: false }`).
2. One or both extractors threw / `runAgentSafe` returned null — the job throws so BullMQ retries with the queue's configured backoff.

Synchronous callers (e.g. `handleOnInbound` invoking the function directly) SHALL catch the failure mode and log it without aborting the inbound pipeline.

#### Scenario: Both extractors return empty — success
- **WHEN** both extractors return `{ data_points: [] }`
- **THEN** the job returns `{ ok: true, dataPoints: 0 }` (no throw, no retry)

#### Scenario: Both extractors fail — retry
- **WHEN** `runAgentSafe` returns null for both extractors
- **THEN** the BullMQ job throws and is retried per the queue's backoff configuration

#### Scenario: Sync caller absorbs failure
- **WHEN** `handleOnInbound` invokes `handleProfileExtract` directly and the function throws
- **THEN** `handleOnInbound` catches, logs `{ event: 'profile_extract_sync_failed', conversationId }`, and continues with the rest of the inbound pipeline; the `DataCollectionPlanner` reads the pre-failure profile snapshot

### Requirement: RateCardExtractor field guard

`RateCardExtractor` SHALL only emit fields that match the regex `^rate\.[a-z][a-z0-9_]*$`. Any other field returned by the LLM SHALL be either remapped to `rate.other` (when a numeric value is present) or dropped (when the value is non-numeric / structurally wrong). The current behavior of blindly prepending `rate.` to any field name SHALL be removed.

#### Scenario: LLM returns `reach.story` — dropped
- **WHEN** the LLM returns a data point with `field = "reach.story"` (out-of-scope for this extractor)
- **THEN** the extractor drops the entry; it does NOT prepend `rate.` to produce `rate.reach.story`

#### Scenario: LLM returns plain `post` — normalized
- **WHEN** the LLM returns a data point with `field = "post"` and a numeric value
- **THEN** the extractor emits `field = "rate.post"`

#### Scenario: LLM returns unrecognized format — bucketed to rate.other
- **WHEN** the LLM returns a data point with `field = "rate.zoom_lecture"` and a numeric value
- **THEN** the extractor preserves it as `rate.other` (or `rate.zoom_lecture` if the format regex matches) — never garbage-prefixes
