## MODIFIED Requirements

### Requirement: Data-collection dialogue planner

For `agency_sourcing` conversations, the inbound pipeline SHALL run a `DataCollectionPlanner` that tracks which automated target data points (resolved from the shared `data-collection-target-fields` registry intersected with the campaign's effective target list, with `manual_only` targets removed) are still missing and proposes the next question to elicit them, one topic at a time. The planner SHALL read each target's `description_for_agent` and `question_template` from the registry rather than from local hardcoded constants, and SHALL include in its output an optional `target_field` key naming the registry entry the proposed reply targets. The worker SHALL persist that key in `Suggestion.meta.targetField` so the data-collection HUD can mark the target as `asked` even before any answer arrives.

#### Scenario: Planner asks for the next missing data point

- **WHEN** the blogger has shared pricing but not audience demographics
- **THEN** the planner proposes a reply that requests audience demographics (using the registry entry's `description_for_agent` and `question_template`) and does not re-ask for pricing

#### Scenario: Planner output carries target_field

- **WHEN** the planner returns a reply targeting `geo`
- **THEN** the output includes `target_field = "geo"` and the worker writes the resulting `Suggestion.meta.targetField = "geo"`

#### Scenario: Editing the registry tunes the bot question in one place

- **WHEN** an engineer changes the `question_template` for `rate_card` in the registry
- **THEN** the next planner run emits the new question and no other module needs editing

#### Scenario: Planner stops when targets are collected

- **WHEN** all automated planner targets for the campaign have been collected (every non-`manual_only` effective target's contributing `ProfileDataPoint` exists)
- **THEN** the planner proposes a closing/thank-you reply, marks the conversation goal as satisfied, and omits `target_field`; any `manual_only` HUD targets remain visible to the operator but do not block the automated close

#### Scenario: Planner ignores campaign targets not in the registry

- **WHEN** a campaign declares `goal.target_data_points = ["rate_card", "unknown_key"]`
- **THEN** the planner treats the effective target list as `["rate_card"]` only, logs a warning naming the unknown key, and never asks a question phrased around the unknown key
