## ADDED Requirements

### Requirement: Structured AJTBD field on Campaign

The system SHALL store an `ajtbd` JSON object on every `Campaign` with the following shape, validated via zod at write time:

```
{
  job: string,
  when: string,
  forces: {
    push: string[],
    pull: string[],
    anxieties: string[],
    habits: string[]
  },
  desired_outcome: string,
  non_goals: string[]
}
```

#### Scenario: Valid AJTBD is accepted
- **WHEN** an admin client submits a campaign create or update request with a well-formed `ajtbd` object
- **THEN** the campaign is persisted with the supplied AJTBD

#### Scenario: Invalid AJTBD is rejected with a 400
- **WHEN** an admin client submits a campaign with an `ajtbd` field that fails zod validation (wrong types, missing required keys)
- **THEN** the API responds with a 400 and a machine-readable error referencing the failing path

### Requirement: AJTBD scaffold backfill for legacy campaigns

When the migration runs, every existing campaign SHALL receive a default AJTBD scaffold derived from its `goalText` and `valueProp` so that downstream agents always have a non-null AJTBD to consume.

#### Scenario: Legacy campaign gets a populated scaffold
- **WHEN** the migration runs on a campaign with `goalText = "Provedem CustDev"` and `valueProp = "Ulushim produkt"`
- **THEN** the campaign's `ajtbd` is set to `{ job: 'Provedem CustDev', when: '', forces: { push: [], pull: [], anxieties: [], habits: [] }, desired_outcome: 'Ulushim produkt', non_goals: [] }`

### Requirement: AJTBD propagation into conversation-stage agents

The system SHALL pass the campaign's AJTBD object into `ReplyComposer`, `HandoffDecider`, `SafetyFilter`, and `GoalFitEvaluator` whenever they are invoked from the `on_inbound` pipeline. The empty-string fallback currently passed for `campaign.goal_text` and `campaign.value_prop` SHALL be replaced.

#### Scenario: ReplyComposer receives AJTBD on inbound
- **WHEN** `agent-run on_inbound` invokes `ReplyComposer` for a conversation belonging to a campaign with a populated AJTBD
- **THEN** the agent input includes an `ajtbd` block whose values match the campaign's stored AJTBD

#### Scenario: GoalFitEvaluator receives AJTBD on inbound
- **WHEN** the gate is invoked on a conversation in `semi_auto` or `auto` mode
- **THEN** the agent input includes the same `ajtbd` block, plus `non_goals` available to the evaluator's policy

#### Scenario: Hardcoded AJTBD fallback is forbidden
- **WHEN** an agent's prompt or input is constructed and the campaign has a null AJTBD
- **THEN** the system uses the scaffold backfill (already applied at migration time) and SHALL NOT inline a hardcoded AJTBD literal in code; if the AJTBD is unexpectedly absent, the agent run SHALL fail explicitly rather than silently use a default

### Requirement: Admin surface for editing AJTBD

The admin UI SHALL provide a dedicated AJTBD editor section on the campaign settings page, with one input per AJTBD field (multi-line text inputs for the string fields and tag-style inputs for the array fields).

#### Scenario: Admin can edit AJTBD fields
- **WHEN** an admin opens a campaign settings page
- **THEN** the AJTBD editor renders all six fields with their current values, allows editing, and persists changes via the existing campaign update endpoint
