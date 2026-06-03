## MODIFIED Requirements

### Requirement: Suggestion meta carries the opener variantKey

When a worker (campaign-dispatcher or `agent-run` `handleOutreachFirstMessage`) creates a `Suggestion` row for an opener composer (`agentName ∈ {'opening_composer', 'agency_opening_composer'}`), the row's `meta` JSON SHALL include `openerVariant: <variantKey>` taken from the composer variant the suggestion was derived from. Existing `meta` keys remain unaffected; the field is additive.

Suggestions created by any other agent (`reply_composer`, `data_collection_planner`, etc.) MUST NOT receive a `meta.openerVariant`.

Any code path that checks "is there already an opener suggestion for this conversation/contact" (e.g. `addContacts` dedup in `apps/api/src/services/campaigns.ts`) SHALL match against the set of opener agent names exposed via a shared constant `OPENER_AGENT_NAMES = ['opening_composer', 'agency_opening_composer'] as const`. No such path SHALL hardcode a single agent name.

#### Scenario: Opener suggestion stores its variantKey in meta
- **WHEN** the campaign dispatcher creates a `Suggestion` for a safe opener variant with `variantKey = 'B'`
- **THEN** the row's `meta.openerVariant` is `'B'`

#### Scenario: addContacts dedup recognizes agency opener
- **WHEN** an operator re-runs `addContacts` for an `agency_sourcing` campaign and the conversation already has a pending opener suggestion saved with `agentName = 'agency_opening_composer'`
- **THEN** `addContacts` treats the opener as present and does NOT create a duplicate suggestion; the dedup matches via `agentName IN OPENER_AGENT_NAMES`

#### Scenario: Reply suggestions are not counted as opener
- **WHEN** a `Suggestion` is created by `reply_composer` or `data_collection_planner`
- **THEN** the row's `meta.openerVariant` is absent and `addContacts` does NOT treat it as an existing opener

## ADDED Requirements

### Requirement: Opener auto-send respects auto_send_eligible

The worker auto-send-loop in both opener call sites (campaign-dispatcher first-message and `agent-run` `handleOutreachFirstMessage`) SHALL filter the candidate set by `auto_send_eligible !== false` BEFORE scoring by safety. Variants with `auto_send_eligible === false` (typically agency variants that cannot truthfully cite a sponsored integration) SHALL still be persisted as `pending` Suggestions but SHALL NOT be auto-approved or auto-sent, regardless of their safety score.

For CustDev's `OpeningComposer`, which does not emit `auto_send_eligible`, the field SHALL be treated as `undefined ≡ eligible`, preserving today's behavior byte-for-byte.

#### Scenario: Agency non-eligible variant is saved but not auto-sent
- **WHEN** `agency_opening_composer` returns one variant with `auto_send_eligible = false` and one with `auto_send_eligible = true`, both pass SafetyFilter, and the conversation is in `auto` mode
- **THEN** both variants are persisted as Suggestions; the auto-approve picks ONLY the `auto_send_eligible = true` variant (or none if it does not pass safety/quality gates), and the non-eligible variant remains `pending`

#### Scenario: All agency variants non-eligible — no auto-send
- **WHEN** every variant returned by `agency_opening_composer` has `auto_send_eligible = false` (e.g. no sponsored integrations were detected)
- **THEN** Suggestions are saved as `pending`; the auto-approve does NOT pick any variant; no `tg-send` job is enqueued; operator UI shows the pending opener

#### Scenario: CustDev opener unaffected
- **WHEN** `opening_composer` returns variants that do not carry `auto_send_eligible`
- **THEN** they are all considered eligible by the worker, and the safety-score ranking is the sole auto-approve criterion (current behavior preserved)
