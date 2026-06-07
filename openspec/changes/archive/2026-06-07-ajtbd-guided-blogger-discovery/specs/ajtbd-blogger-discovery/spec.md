## ADDED Requirements

### Requirement: Guided discovery run

The system SHALL provide an asynchronous guided blogger discovery run that accepts either a `campaignId` whose campaign goal/AJTBD is loaded from the database or a standalone operator brief with AJTBD-like fields. The run SHALL be gated by `channel_discovery`, require an admin/operator role, persist its input, status, timestamps, trace events, candidate results, and final summary, and return quickly with `{ id }` so the UI can poll progress.

#### Scenario: Create a campaign-guided run
- **WHEN** an admin/operator starts guided discovery with a valid `campaignId`
- **THEN** the API persists a guided discovery run with the campaign's goal/AJTBD snapshot, enqueues the guided-discovery worker, and returns `{ id }` without making Yandex or LLM calls inline

#### Scenario: Create a manual brief run
- **WHEN** an admin/operator starts guided discovery with a manual niche/AJTBD brief and no `campaignId`
- **THEN** the API persists the supplied brief as the run input, enqueues the guided-discovery worker, and returns `{ id }`

#### Scenario: Feature flag blocks guided discovery
- **WHEN** `channel_discovery` is off and a request hits guided discovery endpoints
- **THEN** the API responds with the same feature-disabled 404 behavior as the existing discovery routes and no run or worker job is created

### Requirement: LLM discovery query planner

The system SHALL include a seeded `discovery_query_planner` agent that converts the campaign goal/AJTBD or manual brief into a bounded query plan for public blogger discovery. The output SHALL include query text, target platform, rationale, intended audience/topic signal, optional negative terms, and confidence. The planner SHALL be seeded in `agent_config` with schema-validated JSON output and SHALL write an `agent_run` record through the existing agent runner.

#### Scenario: Planner expands one niche into multiple queries
- **WHEN** guided discovery runs for a brief like "B2B fintech founders in Telegram"
- **THEN** `discovery_query_planner` returns multiple platform-scoped search queries with rationale instead of a single raw niche string

#### Scenario: Planner output is bounded
- **WHEN** the planner returns more queries than the run budget allows
- **THEN** the worker deterministically truncates to the configured max query count, records a trace event explaining the truncation, and continues

#### Scenario: Invalid planner output fails the run explicitly
- **WHEN** `discovery_query_planner` returns invalid JSON or no usable queries after retry/fallback
- **THEN** the guided run is marked `failed` with a visible trace event and no Yandex search is attempted

### Requirement: Traceable web-search execution

For every guided discovery run, the system SHALL persist an operator-visible trace of the work performed: planner start/completion, each Yandex search query, result counts, candidate normalization, dedupe decisions, scrape/enrichment status, reviewer decisions, and errors. Trace events SHALL be sanitized and MUST NOT include API keys, encrypted integration payloads, private contact details, or raw hidden data.

#### Scenario: Operator sees what was searched
- **WHEN** the worker executes planned Yandex searches
- **THEN** the run detail response includes each executed query, platform, timestamp, result count, candidate count, and status

#### Scenario: Per-stage errors are visible
- **WHEN** one planned query fails with an upstream error
- **THEN** the run trace records the query-level error, the worker continues with remaining queries when possible, and the UI can render the failed stage without hiding successful candidates

#### Scenario: Secrets are not exposed in trace
- **WHEN** the run detail response is serialized
- **THEN** no Search API key, endpoint secret, encrypted config value, or raw integration config appears in any trace event

### Requirement: Candidate enrichment with public evidence

The guided discovery worker SHALL normalize search results to supported platform channels, deduplicate candidates across all planned queries, create or reuse `Channel` rows, and gather public evidence for each candidate from available channel metadata, recent public posts, and existing `BloggerProfile` data. If a newly discovered candidate has not been scraped yet, the worker SHALL enqueue scrape and mark that candidate as `needs_scrape` or `pending_enrichment` rather than pretending evidence exists.

#### Scenario: Existing channel candidate is reused
- **WHEN** a planned query finds a platform/handle that already exists in `channel`
- **THEN** the candidate links to the existing channel, is not duplicated, and its existing scrape/profile data is used for scoring when available

#### Scenario: New channel candidate is queued for scraping
- **WHEN** a planned query finds a new platform/handle
- **THEN** the system creates `channel(status='new')`, enqueues `channel-scrape`, records that action in the trace, and marks candidate enrichment status according to whether public posts become available within the worker budget

#### Scenario: Evidence only uses public data
- **WHEN** candidate evidence is assembled
- **THEN** it includes only public channel/profile fields, public recent posts, public URLs, and existing public-derived profile data; it SHALL NOT include personal contacts without business context or hidden/private data

### Requirement: Blogger discovery reviewer

The system SHALL include a seeded `blogger_discovery_reviewer` agent that evaluates enriched candidates against the run's AJTBD/brief and returns a fit score, recommendation (`strong_fit`, `possible_fit`, `weak_fit`, `reject`, or equivalent typed enum), rationale, risk notes, and evidence posts. Each evidence post SHALL include a date/id when known, text snippet, URL(s), and explanation of why it matches the brief. The reviewer SHALL only cite supplied candidate data and SHALL NOT invent audience metrics, prices, contacts, or prior integrations.

#### Scenario: Candidate receives a recommendation
- **WHEN** a candidate has enough public metadata or recent posts for review
- **THEN** `blogger_discovery_reviewer` persists a score, recommendation, rationale, and at least one evidence item or an explicit reason why evidence is insufficient

#### Scenario: Reviewer rejects irrelevant channel
- **WHEN** a candidate's posts do not match the AJTBD/brief
- **THEN** the reviewer marks the candidate as weak/rejected with a rationale and the UI does not present it as a recommended blogger

#### Scenario: Reviewer does not invent facts
- **WHEN** candidate data lacks reach, prices, or business contact information
- **THEN** the reviewer leaves those fields unknown and may recommend a scrape/contact-extract follow-up, but SHALL NOT fabricate values

### Requirement: Discovery workbench UI

The Discovery UI SHALL render guided discovery as an operator workbench: input panel for campaign/manual brief, live trace log, planned queries, candidate shortlist, evidence post previews, fit recommendations, and action buttons. Candidate rows/cards SHALL be clickable to inspect channel/profile detail where available and to view matching posts without leaving the run context.

#### Scenario: Run detail shows live trace and candidates
- **WHEN** an operator opens a running guided discovery run
- **THEN** the page polls run detail and renders current status, trace events, planned queries, candidate counts, and any candidates already scored

#### Scenario: Operator inspects matching posts
- **WHEN** an operator expands a recommended blogger candidate
- **THEN** the UI shows the matching public post snippets, dates/links when available, and the reviewer explanation for each evidence item

#### Scenario: Operator opens channel or blogger profile
- **WHEN** a candidate has a linked `Channel` or `BloggerProfile`
- **THEN** the UI provides an action to open the existing channel/profile view using the stored id

#### Scenario: Operator can act on a candidate
- **WHEN** an operator marks a candidate as saved/shortlisted/rejected or requests scrape refresh
- **THEN** the action is persisted on the guided run candidate and reflected in the run detail without mutating unrelated candidates

### Requirement: Cost and budget controls

Guided discovery SHALL enforce per-run budgets for planned query count, Yandex results per query, candidates normalized, candidates reviewed by LLM, and LLM token limits. The run summary SHALL expose budget usage and the worker SHALL stop gracefully when a budget is reached.

#### Scenario: Candidate review budget is reached
- **WHEN** a run finds more candidates than the configured review budget
- **THEN** the worker reviews only the highest-priority candidates, records a trace event for skipped candidates, and includes skipped counts in the run summary

#### Scenario: Agent costs are attributable
- **WHEN** query planning or candidate review agents run
- **THEN** the generated `agent_run` records include the guided discovery run id in metadata or a stable trace reference so operators can attribute cost to a run
