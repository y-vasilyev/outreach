## MODIFIED Requirements

### Requirement: Granular data points preserve provenance and raw text

Each harvested fact SHALL be stored as a `profile_data_point` `{ profile_id, field, value, unit?, confidence, extracted_by, source_message_id, agent_run_id?, raw_snippet, captured_at, superseded_at? }`. The verbatim source text SHALL be preserved in `raw_snippet` (and the original message retained), so the rolled-up profile can be re-derived and audited. LLM-extracted points SHALL carry the `agent_run_id` of the extractor run that produced them (operator-origin points keep it null), so any fact is traceable to the exact model/config/cost that emitted it; the id SHALL be the persisted `agent_run.id` (never a dangling identifier) and SHALL be null when run persistence failed. Data points SHALL never be physically deleted by extraction flows: replacement marks the prior row with `superseded_at`. Default readers (roll-up, HUD, idempotency checks, profile read API) SHALL consider only live rows (`superseded_at IS NULL`); superseded rows SHALL remain retrievable on demand (`includeSuperseded=true` on the profile read, returning `superseded_at` and `agent_run_id`).

#### Scenario: Raw reply text is preserved alongside the parsed value

- **WHEN** an extractor parses "охваты сторис ~12к, пост 25к" into reach data points
- **THEN** each resulting `profile_data_point` stores the parsed numeric value plus the original snippet and a confidence

#### Scenario: Profile roll-up is deterministic from data points

- **WHEN** multiple data points exist for the same field
- **THEN** the `blogger_profile` field is composed deterministically (e.g. latest high-confidence value) from live rows and the contributing data points remain individually retrievable

#### Scenario: Fact traceable to its agent run

- **WHEN** an operator questions a wrong price extracted last week
- **THEN** the data point's `agent_run_id` identifies the exact extractor run (model, config version, tokens) that produced it

#### Scenario: Superseded facts are excluded by default but auditable

- **WHEN** a message was re-analyzed and its prior points superseded
- **THEN** roll-up and HUD reflect only the fresh points, while `includeSuperseded=true` returns both generations with their timestamps
