## MODIFIED Requirements

### Requirement: Structured AJTBD field on Campaign

AJTBD is the goal schema of the `custdev` campaign type within the campaign-type registry, not a field mandatory on every campaign. For campaigns of type `custdev`, the system SHALL store an AJTBD object in `campaign.goal`, validated via zod against the `custdev` type's `goal_schema` at write time, with the following shape:

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

Campaigns of other types (e.g. `agency_sourcing`) store their own type-specific goal object and SHALL NOT be required to carry an AJTBD.

#### Scenario: Valid AJTBD is accepted for custdev campaigns
- **WHEN** an admin client submits a `custdev` campaign create or update request with a well-formed AJTBD object in `campaign.goal`
- **THEN** the campaign is persisted with the supplied AJTBD

#### Scenario: Invalid AJTBD is rejected with a 400
- **WHEN** an admin client submits a `custdev` campaign whose goal fails AJTBD zod validation (wrong types, missing required keys)
- **THEN** the API responds with a 400 and a machine-readable error referencing the failing path

#### Scenario: Non-custdev campaigns are not required to carry AJTBD
- **WHEN** an admin creates an `agency_sourcing` campaign with a valid agency goal object and no AJTBD
- **THEN** the campaign is persisted and no AJTBD validation error is raised

### Requirement: AJTBD scaffold backfill for legacy campaigns

When the migration runs, every existing campaign SHALL be assigned `type_id = custdev` and have its AJTBD moved into `campaign.goal` so that downstream agents always have a non-null goal to consume. Campaigns lacking an AJTBD SHALL receive a default scaffold derived from `goalText` and `valueProp`.

#### Scenario: Legacy campaign gets a populated scaffold under custdev type
- **WHEN** the migration runs on a campaign with `goalText = "Provedem CustDev"` and `valueProp = "Ulushim produkt"` and no prior AJTBD
- **THEN** the campaign's `type_id` is `custdev` and `campaign.goal` is set to `{ job: 'Provedem CustDev', when: '', forces: { push: [], pull: [], anxieties: [], habits: [] }, desired_outcome: 'Ulushim produkt', non_goals: [] }`

#### Scenario: Existing AJTBD is preserved on migration
- **WHEN** the migration runs on a campaign that already had a populated AJTBD
- **THEN** that AJTBD is moved verbatim into `campaign.goal` under `type_id = custdev`

### Requirement: AJTBD propagation into conversation-stage agents

The system SHALL pass the campaign's goal object into `ReplyComposer`, `HandoffDecider`, `SafetyFilter`, and `GoalFitEvaluator` whenever they are invoked from the `on_inbound` pipeline. For `custdev`-type campaigns this goal is the AJTBD object. The system SHALL NOT inline a hardcoded AJTBD literal in code.

#### Scenario: ReplyComposer receives the goal on inbound
- **WHEN** `agent-run on_inbound` invokes `ReplyComposer` for a conversation belonging to a `custdev` campaign with a populated AJTBD
- **THEN** the agent input includes an `ajtbd` block whose values match the campaign's stored goal

#### Scenario: GoalFitEvaluator receives the goal on inbound
- **WHEN** the gate is invoked on a conversation in `semi_auto` or `auto` mode
- **THEN** the agent input includes the campaign's goal object (AJTBD for custdev, the type-specific goal otherwise), including any `non_goals`, available to the evaluator's policy

#### Scenario: Hardcoded goal fallback is forbidden
- **WHEN** an agent's prompt or input is constructed and the campaign has a null goal
- **THEN** the system uses the backfilled goal (applied at migration time) and SHALL NOT inline a hardcoded literal; if the goal is unexpectedly absent, the agent run SHALL fail explicitly rather than silently use a default
