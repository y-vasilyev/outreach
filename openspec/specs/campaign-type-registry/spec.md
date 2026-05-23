## Purpose

Campaign types stored as data in a `campaign_type` registry, so each type declares its own goal schema, agent set, safety profile, and autonomy policy. Pipelines resolve behavior from the conversation's campaign type rather than from hardcoded CustDev constants, enabling CustDev and agency-sourcing (and future types) to coexist.

## Requirements

### Requirement: Campaign type entity

The system SHALL store campaign types as data in a `campaign_type` registry. Each type SHALL declare: a unique `key`, a human `name`, a `goal_schema` (JSON-schema describing the structured goal object campaigns of this type store), an ordered `agent_set` (map of pipeline-role → agent reference + per-type config overrides), a `safety_profile` (forbidden vocabulary, allowed vocabulary, link policy, max length, escalation intents), and an `autonomy_policy` (gate thresholds and intents that force operator handoff). Writes SHALL be validated via zod.

#### Scenario: Valid campaign type is persisted
- **WHEN** an admin creates a campaign type with a well-formed `goal_schema`, `agent_set`, `safety_profile`, and `autonomy_policy`
- **THEN** the type is persisted and returned with a stable `id` and `key`

#### Scenario: Invalid campaign type is rejected
- **WHEN** an admin submits a campaign type whose `agent_set` references a pipeline role that does not exist or whose `goal_schema` is not valid JSON-schema
- **THEN** the API responds 400 with a machine-readable error referencing the failing path and nothing is persisted

### Requirement: Campaign references a type and stores a type-validated goal

Every `Campaign` SHALL reference a `campaign_type` via `type_id`, and SHALL store its structured goal in `campaign.goal` validated against that type's `goal_schema` at write time.

#### Scenario: Campaign goal must satisfy its type schema
- **WHEN** a campaign of type `agency_sourcing` is created with a `goal` object that omits a field required by the type's `goal_schema`
- **THEN** the API responds 400 referencing the missing field and the campaign is not persisted

#### Scenario: Campaign without a type is rejected
- **WHEN** a campaign create request omits `type_id` (after types are mandatory)
- **THEN** the API responds 400 and the campaign is not persisted

### Requirement: Pipelines resolve behavior from the campaign type

The `outreach_first_message`, `on_inbound`, and `followup_check` pipelines SHALL resolve which agents to run, their prompts/config, the safety profile, and the autonomy policy from the conversation's campaign type rather than from hardcoded CustDev constants.

#### Scenario: Inbound pipeline uses the type's agent set and safety profile
- **WHEN** an inbound arrives on a conversation whose campaign is type `agency_sourcing`
- **THEN** the pipeline runs the agency type's configured agents and `SafetyFilter` uses the agency `safety_profile`, not the global CustDev defaults

#### Scenario: CustDev behavior is preserved through the registry
- **WHEN** an inbound arrives on a conversation whose campaign is type `custdev`
- **THEN** the pipeline runs the same agents and applies the same forbidden-vocabulary safety rules as before this change

### Requirement: Seeded base types

The migration SHALL seed at least two campaign types: `custdev` (whose `goal_schema` is the AJTBD shape and whose `safety_profile` forbids ad-sales vocabulary) and `agency_sourcing` (whose `safety_profile` permits commercial vocabulary). Seeding SHALL be idempotent.

#### Scenario: Both base types exist after migration
- **WHEN** the migration and seed run on a fresh database
- **THEN** `campaign_type` contains rows with keys `custdev` and `agency_sourcing`, each with a non-empty `agent_set` and `safety_profile`

#### Scenario: Re-running the seed does not duplicate types
- **WHEN** the seed runs a second time
- **THEN** no duplicate `custdev` or `agency_sourcing` rows are created
