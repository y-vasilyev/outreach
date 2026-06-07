## 1. Data Model And Schemas

- [x] 1.1 Add Prisma migration/models for guided discovery runs, candidates, trace events or a versioned equivalent with persisted input, status, summary, candidates, evidence, and operator decisions.
- [x] 1.2 Add shared zod schemas/types for guided run create input, run status/detail, trace events, planned queries, candidate recommendations, evidence posts, and candidate actions.
- [x] 1.3 Add queue payload schema/name for the guided-discovery worker and expose it through existing shared queue exports.
- [x] 1.4 Add API/service tests for schema validation, feature-flag gating, role requirements, and persistence of guided run input/status.

## 2. Discovery Agents And Seeds

- [x] 2.1 Implement `DiscoveryQueryPlanner` agent class with input/output schemas, variables, JSON output validation, and mocked LLM unit tests.
- [x] 2.2 Implement `BloggerDiscoveryReviewer` agent class with input/output schemas, evidence-post validation, anti-fabrication constraints, and mocked LLM unit tests.
- [x] 2.3 Register both agents in the agent registry and schema hints where needed.
- [x] 2.4 Add default `agent_config` seeds for `discovery_query_planner` and `blogger_discovery_reviewer`, bump seed version, and test seed upgrade behavior.

## 3. Traceable Search Core

- [x] 3.1 Refactor the low-level Yandex discovery execution into a reusable helper that accepts planned queries and returns candidates plus sanitized per-query trace metadata.
- [x] 3.2 Preserve existing `/discovery/search` behavior and response shape while reusing the new helper internally.
- [x] 3.3 Extend candidate provenance to retain source query, original result URL/title, dedupe sources, and known/new channel status.
- [x] 3.4 Add unit tests for multi-query success, partial query failure, duplicate provenance, and secret redaction in trace metadata.

## 4. Guided Discovery Worker

- [x] 4.1 Implement `guided-discovery` worker claim/progress lifecycle with resumable status updates and terminal `done`/`failed` handling.
- [x] 4.2 Resolve campaign goal/AJTBD or manual brief into a stable run input snapshot before any agent/search work.
- [x] 4.3 Run `discovery_query_planner`, persist planner output, enforce max query budget, and write planner trace events.
- [x] 4.4 Execute planned Yandex searches, normalize/dedupe candidates, create/reuse `Channel` rows, enqueue scrape for new channels, and persist query/candidate trace.
- [x] 4.5 Load public channel metadata, recent public posts, existing `BloggerProfile`, and enrichment status for each reviewable candidate.
- [x] 4.6 Run `blogger_discovery_reviewer` within candidate review budget and persist score, recommendation, rationale, risk notes, evidence posts, and skipped counts.
- [x] 4.7 Add worker tests for successful run, planner failure, partial search failure, pending scrape candidate, reviewer anti-fabrication, and budget truncation.

## 5. API Surface

- [x] 5.1 Add `POST /discovery/guided` to create a guided run and enqueue the worker behind `channel_discovery`.
- [x] 5.2 Add `GET /discovery/guided` list endpoint with compact run rows and summary counts.
- [x] 5.3 Add `GET /discovery/guided/:id` detail endpoint returning input snapshot, trace events, planned queries, candidates, evidence, and summary.
- [x] 5.4 Add candidate action endpoints for save/shortlist/reject and scrape refresh, persisting decisions on the run candidate.
- [x] 5.5 Add API tests for create/list/detail/action endpoints, not-found paths, feature-off 404s, and no secret leakage in serialized responses.

## 6. Discovery Workbench UI

- [x] 6.1 Replace the main Discovery page's empty single-query feel with a guided workbench input panel supporting campaign selection and manual AJTBD/brief entry.
- [x] 6.2 Add guided run list/detail navigation while preserving legacy batch visibility as an advanced/debug section if retained.
- [x] 6.3 Render live run status, planned queries, trace log, budget usage, and stage errors with polling.
- [x] 6.4 Render candidate cards/table with score, recommendation, channel/profile metadata, enrichment status, and risk notes.
- [x] 6.5 Add expandable evidence post previews with snippets, links/dates when available, and reviewer explanation.
- [x] 6.6 Add actions to open linked channel/profile, save/shortlist/reject candidate, and request scrape refresh.
- [x] 6.7 Add web tests for create guided run, polling detail, trace rendering, candidate/evidence expansion, action buttons, feature-off state, and legacy batch compatibility.

## 7. Validation And Rollout

- [x] 7.1 Run targeted unit tests for `@nosquare/agents`, `@nosquare/platforms`, `@nosquare/api`, `@nosquare/workers`, and `@nosquare/web` discovery suites.
- [x] 7.2 Run package typechecks for affected packages and `git diff --check`.
- [x] 7.3 Add or update an env-gated live Yandex Search integration test for guided discovery that skips without Search credentials/DB.
- [ ] 7.4 Manually validate a run with real Yandex Search credentials: planner queries appear, trace shows searched queries, candidates include matching posts, and recommendations explain fit.
- [x] 7.5 Verify `channel_discovery` off disables guided endpoints/UI and no worker job is enqueued.
