## ADDED Requirements

### Requirement: Build a campaign type from a plain-language goal

The system SHALL provide a `CampaignTypeBuilder` flow that accepts `{ goal_description: string, examples?: string[], constraints?: object }` and produces a draft `campaign_type` plus draft `agent_config`s for each pipeline role (opening, reply, intent, safety, gate, and any type-specific extractors). For each drafted agent the builder SHALL select a model tier (cheap/medium/strong) mapped to an available endpoint, write a system prompt and user-prompt template, and define an output JSON-schema where structured output is required.

#### Scenario: Builder returns a complete draft
- **WHEN** an operator submits a goal description for a new campaign type
- **THEN** the builder returns a draft containing a `goal_schema`, a `safety_profile`, and one drafted agent config per required pipeline role, each with a chosen endpoint, model, prompts, and params

#### Scenario: Builder selects models by tier, not hardcoded names
- **WHEN** the builder drafts agents and only a subset of model tiers have configured endpoints
- **THEN** each drafted agent is assigned an endpoint that exists for its required tier, and the builder reports any tier that has no available endpoint rather than emitting an unusable reference

### Requirement: Builder runs drafted agents against test fixtures before save

The builder SHALL execute each drafted agent against test fixtures using the existing `dry_run` path and attach per-agent results (output, token counts, latency, cost) to the draft. Drafted agents SHALL NOT be persisted as live `agent_config` rows until the operator explicitly saves the draft.

#### Scenario: Test results are attached to the draft
- **WHEN** the builder finishes drafting
- **THEN** the returned draft includes, per agent, the dry-run output plus `tokens_in`, `tokens_out`, `cost_usd`, and `latency_ms`

#### Scenario: Draft is not live until saved
- **WHEN** the builder produces a draft but the operator has not saved it
- **THEN** no new `agent_config` rows exist and no campaign can reference the drafted type

### Requirement: Saving a draft creates editable, versioned config

Saving a builder draft SHALL create the `campaign_type` row and real `agent_config` rows (version 1, recorded in `agent_config_history`). All produced agents SHALL remain editable through the existing agent configuration UI.

#### Scenario: Saved type is editable
- **WHEN** an operator saves a builder draft and later opens one of its agents in the agent UI
- **THEN** the agent's prompts, model, and params are editable and saving creates a new `agent_config_history` version

#### Scenario: Save is audited
- **WHEN** an operator saves a builder draft
- **THEN** an `audit_log` entry records the action, the actor, and the created campaign type
