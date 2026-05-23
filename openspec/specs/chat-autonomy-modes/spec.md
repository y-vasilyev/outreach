## Purpose

Per-conversation autonomy levels (`manual`, `assisted`, `semi_auto`, `auto`) that decide whether agent-generated drafts can be sent without operator approval, plus the runtime contract for silently flipping a conversation back to operator control without leaving any contact-visible artifact.
## Requirements
### Requirement: Conversation autonomy modes

The system SHALL support four autonomy modes per conversation: `manual`, `assisted`, `semi_auto`, `auto`. Each mode defines whether agent-generated drafts can be sent without operator approval and how the system reacts to a quality-gate signal.

- `manual`: no agent activity beyond intent classification. No suggestions are generated, no outbound is auto-sent.
- `assisted`: agents generate operator-facing suggestions on every inbound; nothing is auto-sent.
- `semi_auto`: drafts are auto-sent when both the safety check and the goal-fit gate clear their `semi_auto` thresholds; otherwise the best safe draft is persisted as a `pending` suggestion.
- `auto`: drafts are auto-sent when safety, goal-fit, and the gate's `continue` action all hold under the stricter `auto` thresholds; when the gate returns `handoff_silent`, the conversation SHALL flip to `assisted` without producing any outbound.

#### Scenario: Manual mode does not generate suggestions
- **WHEN** an inbound message arrives on a conversation in `manual` mode
- **THEN** no `Suggestion` rows are created, no outbound is sent, and no LLM cost is incurred beyond what the system uses to record the inbound

#### Scenario: Assisted mode always produces suggestions, never auto-sends
- **WHEN** an inbound arrives on a conversation in `assisted` mode and the agent pipeline produces safe drafts
- **THEN** the drafts are persisted as `pending` suggestions and no outbound message is created or queued

#### Scenario: Semi-auto sends only when both safety and goal-fit clear semi-auto thresholds
- **WHEN** an inbound arrives on a conversation in `semi_auto` mode and the resulting top draft has `safety.allow = true`, `1 - risk_score ≥ T_safety`, `gate.action ∈ {continue, soften}`, and `gate.score ≥ T_semi_auto_goalfit`
- **THEN** the draft is auto-approved and queued for send; otherwise the best safe draft is persisted as a `pending` suggestion

#### Scenario: Auto mode requires stricter goal-fit and uses gate.continue
- **WHEN** an inbound arrives on a conversation in `auto` mode and the resulting top draft has `safety.allow = true`, `1 - risk_score ≥ T_safety`, `gate.action == continue`, and `gate.score ≥ T_auto_goalfit`
- **THEN** the draft is auto-approved and queued for send

#### Scenario: Auto mode falls back silently on gate handoff
- **WHEN** an inbound arrives on a conversation in `auto` mode and the gate returns `action == handoff_silent`
- **THEN** the system SHALL set `Conversation.mode = 'assisted'`, persist the gate decision in `Conversation.qualityDecision`, leave the best safe draft as a `pending` suggestion, emit a `quality.gate` realtime event to the operator room only, and SHALL NOT create or queue any outbound message

### Requirement: Mode propagation from campaign default

The system SHALL apply `Campaign.defaultMode` as the initial `Conversation.mode` whenever a new conversation is created in the context of that campaign.

#### Scenario: Conversation inherits campaign default mode
- **WHEN** a new conversation is created for a contact under a campaign with `defaultMode = 'semi_auto'`
- **THEN** the conversation is persisted with `mode = 'semi_auto'`

#### Scenario: Existing assisted default remains the fallback
- **WHEN** a new conversation is created without a campaign or for a campaign whose `defaultMode` is null
- **THEN** the conversation defaults to `mode = 'assisted'`

### Requirement: Operator-controlled mode transitions

The operator SHALL be able to change a conversation's mode at any time via the existing `PATCH /conversations/:id` endpoint, and the system SHALL accept all four mode values.

#### Scenario: Operator switches a conversation back to auto
- **WHEN** the operator sends `PATCH /conversations/:id { mode: 'auto' }` on a conversation currently in `assisted` mode
- **THEN** the conversation's mode is updated, `Conversation.qualityDecision` is cleared, and a `mode.changed` realtime event is emitted

#### Scenario: Operator switches to manual to take full control
- **WHEN** the operator sends `PATCH /conversations/:id { mode: 'manual' }`
- **THEN** the conversation's mode is updated, any pending suggestions remain readable but no new ones are generated until mode is changed back

### Requirement: Silent fallback contract toward the contact

When the system silently flips a conversation from `auto` to `assisted` due to a gate decision, the contact-facing surface SHALL remain unchanged: no message is sent, no typing indicator is emitted, and the only observable consequence to the contact is the operator's natural reply latency.

#### Scenario: Silent flip emits no contact-visible artifact
- **WHEN** the gate triggers `handoff_silent` and the system flips the conversation to `assisted`
- **THEN** no message of any direction or sender is created, no `tg-send` job is enqueued, and no realtime event reaches a non-operator subscriber

### Requirement: Renaming `auto` to `semi_auto`

The mode previously named `auto` SHALL be renamed to `semi_auto`. The new `auto` mode introduces stricter behavior with silent fallback and is not backward-compatible with the previous semantics.

The rename SHALL be delivered as **two physically separate database migrations** so that `prisma migrate deploy` succeeds on a fresh Postgres cluster. Postgres forbids using a value added via `ALTER TYPE ... ADD VALUE` in the same transaction in which the value is added; consequently the migration adding `semi_auto` to the `ConversationMode` enum MUST commit before any migration that issues `UPDATE` statements referencing `semi_auto`.

#### Scenario: Existing data is migrated

- **WHEN** the schema migrations run on a database with conversations or campaigns whose mode is the legacy `auto`
- **THEN** the enum-add migration commits the new `semi_auto` value first, and a subsequent backfill migration updates all such rows to `semi_auto` before the new `auto` semantics are introduced

#### Scenario: Fresh Postgres cluster accepts the migration set

- **WHEN** `prisma migrate deploy` is run against a Postgres database with no migration history
- **THEN** every migration applies cleanly with no `unsafe use of new value 'semi_auto' of enum type ConversationMode` error, and the database ends in a state where `ConversationMode` contains both `auto` and `semi_auto`

#### Scenario: Backfill migration is idempotent

- **WHEN** the `semi_auto` backfill migration is executed against a database that already has no `mode = 'auto'` (or `defaultMode = 'auto'`) rows
- **THEN** the migration succeeds as a no-op (zero rows updated) without raising any error

#### Scenario: API normalises legacy input during transition

- **WHEN** during the migration window an API client submits `mode = 'auto'` matching the legacy semantics
- **THEN** the system SHALL accept the value, normalise it to `semi_auto` on write, and respond successfully; once the rename is complete, `auto` shall mean the new strict mode and no normalisation occurs

