# opener-ab-variants Specification

## Purpose
TBD - created by archiving change ab-opener-variants. Update Purpose after archive.
## Requirements
### Requirement: Opener composers emit stable variantKey per variant

`OpeningComposer` (`opening_composer`) and `AgencyOpeningComposer` (`agency_opening_composer`) SHALL include a non-empty stable string `variantKey` on every variant they emit. The LLM MAY supply the key via the optional `variant_key` field on each variant; when it does not, a deterministic post-process SHALL assign the next-free alphabetical fallback (`'A'`, `'B'`, `'C'`, … rolling over any letter already claimed by an LLM-supplied key). Within a single composer invocation, `variantKey` values MUST be unique (duplicates from the LLM SHALL be suffixed `_2`, `_3`, … by the post-process).

The composer output contract (`variants[]` items now carrying `variantKey`) MUST remain backward-compatible for downstream consumers: existing fields (`text`, `rationale`, `length`, `risk_score`, and agency-only `cited_integration` / `auto_send_eligible`) keep their meaning and validation.

#### Scenario: LLM omits variant_key — post-process assigns alphabetical keys

- **WHEN** the LLM returns three variants without any `variant_key` field
- **THEN** the composer's output has `variants[0].variantKey = 'A'`, `variants[1].variantKey = 'B'`, `variants[2].variantKey = 'C'`

#### Scenario: LLM supplies variant_key — composer preserves it

- **WHEN** the LLM returns two variants with `variant_key: 'concise'` and `variant_key: 'value_prop'`
- **THEN** the composer's output preserves both keys verbatim (after trim and length-cap to 32 chars)

#### Scenario: LLM supplies duplicate variant_key — post-process disambiguates

- **WHEN** the LLM returns three variants all with `variant_key: 'short'`
- **THEN** the composer's output has `variantKey = 'short'`, `'short_2'`, `'short_3'` respectively

#### Scenario: LLM supplies blank or whitespace-only variant_key — post-process falls back

- **WHEN** the LLM returns a variant with `variant_key: '   '`
- **THEN** the composer treats it as missing and assigns the alphabetical fallback for that index

### Requirement: Suggestion meta carries the opener variantKey

When a worker (campaign-dispatcher or `agent-run` `handleOutreachFirstMessage`) creates a `Suggestion` row for an opener composer (`agentName ∈ {'opening_composer', 'agency_opening_composer'}`), the row's `meta` JSON SHALL include `openerVariant: <variantKey>` taken from the composer variant the suggestion was derived from. Existing `meta` keys (none today) remain unaffected; the field is additive.

Suggestions created by any other agent (`reply_composer`, `data_collection_planner`, etc.) MUST NOT receive a `meta.openerVariant`.

#### Scenario: Opener suggestion stores its variantKey in meta

- **WHEN** the campaign dispatcher creates a `Suggestion` for a safe opener variant with `variantKey = 'B'`
- **THEN** the row is persisted with `meta = { openerVariant: 'B' }`

#### Scenario: Non-opener suggestion has no openerVariant in meta

- **WHEN** a reply pipeline creates a `Suggestion` with `agentName = 'reply_composer'`
- **THEN** the row's `meta` does NOT contain an `openerVariant` key

### Requirement: Message persists openerVariant when sent from an opener suggestion

The `Message` model SHALL have a nullable column `openerVariant: String?`. When an outbound `Message` is created from a `Suggestion` whose `agentName ∈ {'opening_composer', 'agency_opening_composer'}`, the worker (auto-approve path) and the API (operator-approve path, `sendOperatorMessage` / `approveSuggestion`) SHALL copy `Suggestion.meta.openerVariant` into `Message.openerVariant`. Messages not originating from an opener suggestion (replies, operator-only sends, inbound messages) MUST leave `Message.openerVariant` as `null`.

A database index SHALL exist on `(conversationId, openerVariant)` to keep stats queries cheap.

#### Scenario: Auto-approve writes openerVariant onto the outbound message

- **WHEN** `tryAutoApprove` approves an opener suggestion whose `meta.openerVariant = 'A'` and creates a pending outbound `Message`
- **THEN** the created `Message` has `openerVariant = 'A'`

#### Scenario: Operator approval writes openerVariant onto the outbound message

- **WHEN** an operator approves an opener suggestion with `meta.openerVariant = 'value_prop'` via `POST /conversations/:cid/suggestions/:sid/approve`
- **THEN** the created `Message` has `openerVariant = 'value_prop'`

#### Scenario: Reply messages have null openerVariant

- **WHEN** the reply pipeline creates an outbound `Message` from a `reply_composer` suggestion
- **THEN** the created `Message` has `openerVariant = null`

#### Scenario: Operator ad-hoc message (no fromSuggestionId) has null openerVariant

- **WHEN** an operator sends a message directly via `sendOperatorMessage` without `fromSuggestionId`
- **THEN** the created `Message` has `openerVariant = null`

#### Scenario: fromSuggestionId scoped to a different conversation is rejected

- **WHEN** a caller invokes `sendOperatorMessage({ conversationId: 'A', fromSuggestionId: 'sug_from_B' })` where the suggestion belongs to conversation B
- **THEN** the call SHALL throw `AppError(NOT_FOUND)` for the suggestion, and SHALL NOT create the outbound `Message`, NOR flip the foreign suggestion's `status` to `sent`, NOR copy its `meta.openerVariant`

### Requirement: GET /campaigns/:id/opener-stats reports per-variant counters

The API SHALL expose `GET /campaigns/:id/opener-stats?withinHours=<H>` (admin / operator / viewer roles). The endpoint returns an array of `{ variantKey, sent, replied, replyRate }` rows — one row per distinct `Message.openerVariant` value observed across the campaign's conversations.

- `sent` SHALL count `Message` rows where `direction = 'out_'`, `status = 'sent'`, `openerVariant = <key>`, and `conversation.campaignId = :id`.
- `replied` SHALL count those `sent` rows for which the same `conversation` has at least one inbound `Message` (`direction = 'in_'`) with `createdAt` between the opener's `sentAt` and `sentAt + withinHours hours`.
- `replyRate` SHALL equal `sent > 0 ? replied / sent : 0`, clamped to `[0, 1]` (defensive — guards against the rare race where a reply is double-counted).
- `withinHours` query parameter SHALL default to `48` and SHALL be validated to the inclusive range `[1, 720]` (30 days). Invalid values yield a 400 with the standard `AppError` shape.
- Rows SHALL be sorted by `variantKey` ascending for stable presentation.
- Messages with `openerVariant = null` SHALL be excluded — they are not opener-attributable.

The endpoint SHALL be read-only (`GET`, no audit log entry), no LLM calls, no side effects.

#### Scenario: Two variants, one received a reply

- **GIVEN** a campaign with two opener variants A and B; 5 messages sent for variant A, 3 sent for variant B; one conversation in the A bucket has an inbound 12 hours after the opener
- **WHEN** an operator calls `GET /campaigns/:id/opener-stats`
- **THEN** the response is `[{ variantKey: 'A', sent: 5, replied: 1, replyRate: 0.2 }, { variantKey: 'B', sent: 3, replied: 0, replyRate: 0 }]`

#### Scenario: Reply outside the window does not count

- **GIVEN** an opener sent for variant `'A'` at T, an inbound at T+72h, and the caller passes `withinHours=48`
- **WHEN** the stats endpoint runs
- **THEN** the row for `'A'` has `replied = 0`

#### Scenario: Default window is 48 hours

- **WHEN** an operator calls `GET /campaigns/:id/opener-stats` without a `withinHours` parameter
- **THEN** the endpoint treats `withinHours = 48`

#### Scenario: Invalid withinHours yields 400

- **WHEN** an operator calls `GET /campaigns/:id/opener-stats?withinHours=0` or `withinHours=10000`
- **THEN** the endpoint returns `400` with an `AppError` indicating the value is out of the inclusive `[1, 720]` range

#### Scenario: Campaign with no opener-tagged messages returns empty array

- **GIVEN** a brand-new campaign whose conversations have no `Message.openerVariant` populated yet
- **WHEN** the stats endpoint runs
- **THEN** the response is `[]`

#### Scenario: Unauthorized role is rejected

- **WHEN** a user without `admin`, `operator`, or `viewer` role calls the endpoint
- **THEN** the request is rejected with `403`

#### Scenario: Campaign not found returns 404

- **WHEN** the endpoint is called with an unknown `:id`
- **THEN** the response is `404` with an `AppError` `NOT_FOUND` code

