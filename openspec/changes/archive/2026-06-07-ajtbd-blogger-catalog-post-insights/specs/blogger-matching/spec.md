## ADDED Requirements

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
