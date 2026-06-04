## ADDED Requirements

### Requirement: HUD endpoint returns per-target state for a conversation

The system SHALL expose `GET /conversations/:id/data-collection` returning `{ campaignTypeKey: string | null, targets: Target[] }` where each `Target` is `{ key, label, description_for_operator, freshness_section, manual_only?: boolean, state: "answered" | "asked" | "missing" | "stale", current?: { value, capturedAt, sourceMessageId?: string, sourceField: string }, lastAskedAt?: string, freshness?: { stale: boolean, ageDays: number | null } }`. The endpoint SHALL respect the conversation's campaign type's effective target list (from `data-collection-target-fields`).

#### Scenario: Endpoint returns one row per effective target

- **WHEN** an operator opens a conversation whose campaign has effective targets `[rate_card, reach, audience_demographics, geo]`
- **THEN** the response contains exactly four `targets[]` entries in the registry's declared order, each carrying its `label` and `description_for_operator`

#### Scenario: Conversation without a campaign returns an empty target list

- **WHEN** the conversation has no campaign or the campaign's type key is not in the registry's supported types
- **THEN** the response is `{ campaignTypeKey: null, targets: [] }` (200, not 404) so the UI renders an empty state without error handling

### Requirement: Per-target state classification

For each effective target the endpoint SHALL first compute that target's own data-point subset: `targetDataPoints = ProfileDataPoint[]` whose `field` satisfies one of the target registry entry's `profile_data_point_keys[]` via `profileFieldMatchesTarget(...)` (exact-or-dotted-subkey). It SHALL then compute target-local freshness by calling `computeProfileFreshness(targetDataPoints)` and reading the target's `freshness_section`. This target-local computation is required even when several targets share the same freshness section (for example `audience_demographics` and `geo` both map to `audience`).

For each effective target the endpoint SHALL classify state as follows:

- `answered` — at least one target-matching `ProfileDataPoint` contributes to the target's `freshness_section` according to `computeProfileFreshness`'s usability rules, and target-local `freshness.stale` is `false`.
- `stale` — same condition as `answered`, but target-local `freshness.stale` is `true`.
- `asked` — no answered/stale match exists, and at least one `Suggestion` on this conversation has `meta.targetField` equal to this target's `key`.
- `missing` — none of the above.

`current` SHALL be the newest target-matching data point that contributes to the target's `freshness_section`, carrying `{ value, capturedAt, sourceMessageId?, sourceField }`. `freshness` SHALL be omitted when there is no `current`.

`manual_only` targets SHALL NOT be auto-classified as `answered` or `stale` from `ProfileDataPoint` rows; Phase 1 has no operator-action write path for them, so they stay `missing` in the HUD even when extractor rows with arbitrary `contact.*` fields exist.

#### Scenario: Fresh data point yields answered

- **WHEN** a `ProfileDataPoint` for `rate.story` was captured 10 days ago (rate-card TTL 90 days)
- **THEN** the `rate_card` target is `answered` with `current.value` set, `current.capturedAt` populated, and `freshness = { stale: false, ageDays: 10 }`

#### Scenario: Shared freshness sections remain target-local

- **WHEN** the profile has a fresh `audience.age` data point but only a stale `audience.geo` data point
- **THEN** `audience_demographics` is `answered` and `geo` is `stale`; the fresh demographic observation does not make `geo` fresh

#### Scenario: Aged data point yields stale

- **WHEN** the most recent contributing data point for `rate_card` was captured 120 days ago
- **THEN** the target is `stale`, `current` is the aged data point, and `freshness.stale = true`

#### Scenario: Suggestion targeted but no answer yields asked

- **WHEN** the conversation has a `Suggestion` with `meta.targetField = "audience_demographics"` and no contributing `ProfileDataPoint`
- **THEN** the target is `asked` and `lastAskedAt` equals the suggestion's `createdAt`

#### Scenario: Neither asked nor answered yields missing

- **WHEN** the target has no contributing `ProfileDataPoint` and no `Suggestion` with `meta.targetField` equal to it
- **THEN** the target is `missing`

### Requirement: Realtime dataCollectionUpdated event

The system SHALL emit a `dataCollectionUpdated` realtime event `{ conversationId, targetKey, state, current?, lastAskedAt?, freshness? }` on the conversation's existing room after every successful `ProfileDataPoint` write affecting an effective target and after every `Suggestion` create whose `meta.targetField` matches an effective target. In the current architecture these writes originate in workers (`profile-extract` for data points, `agent-run` for suggestions) and are published through the existing worker Redis realtime bridge; the API realtime process only broadcasts the pub/sub payload to Socket.IO subscribers. The web inbox panel SHALL consume the event and patch its local cache in place.

#### Scenario: Extractor write fires one event per affected target

- **WHEN** `RateCardExtractor` writes a `ProfileDataPoint` for `rate.post`
- **THEN** exactly one `dataCollectionUpdated` event is emitted with `targetKey = "rate_card"`, the new `current` value, and `state = "answered"` (or `stale` per the section freshness)

#### Scenario: Suggestion with targetField fires one event

- **WHEN** the worker creates a `Suggestion` with `meta.targetField = "geo"` for a conversation where `geo` was previously `missing`
- **THEN** one event is emitted with `targetKey = "geo"`, `state = "asked"`, and `lastAskedAt` set

#### Scenario: Subscriber outside the conversation room receives nothing

- **WHEN** a `dataCollectionUpdated` event fires for `conversation_42`
- **THEN** clients subscribed to other conversation rooms receive no event for this update

### Requirement: HUD respects the feature flag

When `data_collection_hud` is OFF, the HUD endpoint SHALL respond 404 (gated by `requireFeature`), the realtime emitter SHALL early-return without publishing, and the inbox right panel SHALL render the legacy minimal sidebar. When ON, the endpoint, the WS event, and the panel SHALL be fully functional.

#### Scenario: Flag off hides the HUD

- **WHEN** the flag is OFF and an operator opens a conversation
- **THEN** the endpoint returns 404 and the inbox UI renders the pre-change sidebar without crashing

#### Scenario: Flag on serves the HUD

- **WHEN** the flag is ON
- **THEN** the endpoint returns the target state, the panel renders, and writes trigger realtime updates
