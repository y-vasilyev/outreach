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

### Requirement: Matching can use structured placement attributes
The blogger matching system SHALL use structured placement offers when available to evaluate format, platform, duration, deletion policy, included deliverables, tax terms, and price constraints. If structured offers are absent, matching SHALL fall back to legacy `rateCards`.

#### Scenario: Brief requires long-lived Telegram post
- **WHEN** a brief asks for a Telegram post that remains for a month or longer
- **THEN** matching ranks profiles with `platform=telegram`, `kind=post`, and `duration=month` or equivalent deletion policy above profiles that only offer a one-day post

#### Scenario: Matching falls back to legacy rates
- **WHEN** a profile has no structured placement offers but has legacy `rateCards`
- **THEN** matching continues to score the profile using the legacy rate-card behavior

### Requirement: Matching explains structured placement fit
When a match score depends on structured placement attributes, the system SHALL include those attributes in the match rationale so an operator can verify why a profile was selected or penalized.

#### Scenario: Rationale cites placement terms
- **WHEN** a candidate is selected because it offers an offsite review that includes a permanent post and event announcement
- **THEN** the match rationale mentions those placement terms rather than only the synthetic rate-card format

### Requirement: Matching can compare on v2 representation

Brief matching SHALL be able to use per-platform audience and the v2 placement terms (`price_period`, `prepayment`, `tax_regime`) when scoring and summarizing candidates, without regressing the legacy rate-card fallback. When a brief targets a specific platform, candidate ranking SHALL be able to use that platform's `platformAudience` subscriber count. For budget fit, when an offer carries multiple `price_period` variants for the same format, matching SHALL use the `base` price (falling back to `seasonal`/`promo` only when no `base` exists), so a temporary markup does not wrongly fail a candidate. Structured v2 matching SHALL remain behind the existing `structured_placement_offers` preference flag (default off); this change SHALL NOT alter that default. The shared matchable profile, the API match serialization, and the web profile type SHALL all carry `platformAudience` so it reaches ranking and display.

#### Scenario: Per-platform audience informs ranking

- **WHEN** a brief targets Telegram and two candidates differ in Telegram subscriber count
- **THEN** matching can rank the larger Telegram audience higher using `platformAudience`, not a blended scalar

#### Scenario: Seasonal price does not distort budget fit

- **WHEN** an offer is marked `price_period = seasonal`
- **THEN** matching can prefer the `base` price for budget comparison so a temporary seasonal markup does not wrongly fail a candidate

### Requirement: Budget fit compares in normalized RUB

Budget prefilter and `budgetScore` SHALL evaluate offers via `priceRubMin`, falling back to the raw `price` when normalized columns are null (unknown currency, pre-migration rows). For an all-RUB catalog with no ranges the matching output SHALL be byte-identical to the pre-change behavior (regression fixture). `fitSignals` SHALL include `{cpmRub, currency, fxAsOf}` for cited offers and the rationale SHALL mention CPM when present; score weights are unchanged.

#### Scenario: USD offer meets a RUB budget correctly

- **WHEN** a brief has budget 30 000 ₽ and a profile's only relevant offer is $400 with USD rate 92.4
- **THEN** the offer is evaluated as 36 960 ₽ and the profile is excluded as over budget — whereas the raw comparison (400 < 30 000) would have wrongly shortlisted it

#### Scenario: All-RUB catalog is regression-safe

- **WHEN** matching runs over a catalog where every offer is RUB with `fxRateUsed=1` and no ranges
- **THEN** scores, order, and rationales are identical to the pre-change implementation

#### Scenario: CPM informs but does not rank

- **WHEN** two candidates have equal scores and different CPM
- **THEN** their relative order is unchanged by CPM, and both `fitSignals` expose their `cpmRub`

### Requirement: Matching stage-1 uses a SQL pre-cut with superset guarantee

Matching candidate selection SHALL apply a SQL pre-cut over `placement_offer` rows for brief conditions expressible as offer filters (platform, kind/format, budget via `priceRubMin`), then run the existing in-memory shortlist check unchanged over the pre-cut set. The pre-cut SHALL always be a superset of the final shortlist: conditions it cannot express safely are simply not applied at SQL level; profiles with zero active offer rows SHALL always be included (the legacy `rateCards` fallback evaluates them in memory); and with `structured_placement_offers` off the pre-cut SHALL not run at all (full scan as today). Final candidate sets and their order SHALL be identical to the full-scan implementation (regression-proven over seeded fixtures running both paths, including flag-off and legacy-only-profile fixtures).

#### Scenario: Pre-cut does not change match results

- **WHEN** the same brief is matched via the legacy full-catalog scan and via the SQL pre-cut path over identical data
- **THEN** the final ranked candidates are identical in membership and order

#### Scenario: Inexpressible conditions fall through to in-memory checks

- **WHEN** a brief constrains only topics (not expressible as an offer filter)
- **THEN** the pre-cut applies no offer-level narrowing and the in-memory shortlist performs the topic filtering as before

#### Scenario: Legacy-only profile is not excluded by the pre-cut

- **WHEN** a profile has legacy `rateCards` but no `placement_offer` rows and the brief sets a budget
- **THEN** the pre-cut still includes the profile and the in-memory shortlist evaluates its rate cards exactly as before

