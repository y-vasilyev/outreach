## Purpose

Match incoming advertising briefs against the blogger catalog. A validated `ad_brief` drives two-stage matching — a deterministic SQL prefilter over `blogger_profile` followed by scored, rationale-bearing ranking persisted as `match_result` rows — with an optional, cost-bounded LLM re-rank of the top N candidates.

## Requirements

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

### Requirement: Match results expose fit breakdown

Matching SHALL expose a structured fit breakdown in addition to the existing score and rationale. Each match candidate SHALL include positive signals, gaps, score breakdown, and evidence post ids when such evidence exists. Persisted `match_result` rows SHALL retain this fit metadata so later catalog or match views can render the same explanation without rerunning the matcher.

#### Scenario: Match response includes structured explanation
- **WHEN** matching ranks a blogger profile for an advertising brief
- **THEN** each returned candidate includes score, rationale, positive signals, gaps, and score breakdown fields

#### Scenario: Match result links top-post evidence
- **WHEN** a candidate's relevance is supported by stored public post insights
- **THEN** the match result includes the relevant post insight ids so the UI can show the evidence posts next to the rationale

#### Scenario: No post evidence is explicit
- **WHEN** a candidate has commercial fit but no stored post insights relevant to the brief
- **THEN** the match result leaves evidence post ids empty and includes a gap explaining that post evidence is unavailable

### Requirement: LLM rerank preserves structured fit metadata

When optional LLM reranking is enabled, the system SHALL keep the deterministic structured fit metadata for every candidate and MAY let the LLM revise only the candidate order, score, and rationale within the bounded top-N set. The rerank SHALL NOT invent post evidence ids, metrics, prices, or audience facts.

#### Scenario: Rerank keeps deterministic evidence ids
- **WHEN** the bounded LLM rerank changes a candidate's score or rationale
- **THEN** the response and persisted match result still include only evidence post ids that came from stored post insights

#### Scenario: Rerank omits a candidate
- **WHEN** the LLM output omits a candidate from the bounded input set
- **THEN** the service keeps that candidate with its deterministic fit metadata and does not drop its structured explanation
