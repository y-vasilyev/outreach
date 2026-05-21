## ADDED Requirements

### Requirement: Ad brief intake

The system SHALL accept an `ad_brief` `{ topic, audience_target, budget?, formats?, geo?, deadline?, notes? }`, validated via zod, representing an incoming advertising request to match against the blogger catalog.

#### Scenario: Valid brief is accepted
- **WHEN** an operator submits a brief with a topic and audience target
- **THEN** the brief is persisted and returns a `brief_id`

#### Scenario: Invalid brief is rejected
- **WHEN** a brief omits the required topic field
- **THEN** the API responds 400 referencing the missing field

### Requirement: Two-stage matching over the catalog

Matching SHALL run a deterministic SQL prefilter over `blogger_profile` (topic overlap, geo, format availability, and budget vs known rate cards) to produce a shortlist, then score and rank the shortlist. Each result SHALL include a numeric score and a rationale. Results SHALL be persisted as `match_result` rows linked to the brief for auditability.

#### Scenario: Prefilter excludes irrelevant profiles
- **WHEN** a brief targets geo=RU and format=reels and a profile offers neither
- **THEN** that profile is excluded from the shortlist before scoring

#### Scenario: Ranked candidates carry a rationale
- **WHEN** matching runs against a catalog with several qualifying profiles
- **THEN** the response returns candidates ordered by score, each with a human-readable rationale, and `match_result` rows are persisted for the brief

#### Scenario: Budget-aware ranking
- **WHEN** a brief has a budget and two otherwise-equal profiles differ in known rate card
- **THEN** the profile that fits the budget ranks higher and the rationale references the rate-card fit

### Requirement: Optional LLM re-rank is bounded

A `BloggerMatcher` agent MAY re-rank the top N shortlisted candidates for nuanced fit. LLM re-ranking SHALL be bounded to the top N (configurable) to contain cost and SHALL write `agent_run`. Deterministic scoring SHALL remain available without the LLM.

#### Scenario: Re-rank touches only the top N
- **WHEN** LLM re-rank is enabled with N=10 and the shortlist has 50 candidates
- **THEN** at most the top 10 deterministic candidates are sent to the matcher agent and the remainder keep their deterministic order

#### Scenario: Matching works with LLM re-rank disabled
- **WHEN** the re-rank flag is off
- **THEN** matching still returns ranked candidates from deterministic scoring and issues no LLM call
