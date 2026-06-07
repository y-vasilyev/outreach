## Context

Discovery currently has two entry points: `POST /discovery/search` for one query and `POST /discovery/batch` for a list of operator-supplied niches. Both use the encrypted `yandex_search` integration, normalize direct social URLs into `Channel` rows, and enqueue `channel-scrape`; the UI shows counts and per-query status only. It does not understand a campaign's AJTBD/agency brief, does not generate search strategy, does not expose which concrete Yandex queries were executed, and does not show candidate posts or a fit recommendation.

The codebase already has the right building blocks: `AgentRunner` + `agent_config` seed/versioning, `YandexSearchClient`, platform adapters, `channel-scrape`, `BloggerProfile`, profile extraction, the blogger catalog, and `BloggerMatcher`. This change should compose those primitives into a discovery workbench instead of building a separate crawler or recommendation stack.

## Goals / Non-Goals

**Goals:**

- Turn Discovery into an AJTBD/brief-guided workflow that produces a reviewable shortlist of bloggers, not only raw channel handles.
- Seed default multiagent configs for discovery query planning and candidate recommendation/scoring.
- Persist every guided discovery run with an operator-visible trace: agent plan, exact web-search queries, result counts, normalization, scraping/enrichment status, scoring decisions, errors, and final recommendation.
- Return candidate blogger cards with channel/profile metadata, matching post examples, fit score, rationale, risk notes, and recommended operator action.
- Make candidates actionable in the UI: open channel/profile detail, inspect posts, refresh/queue scrape, save/shortlist, and start downstream agency review without losing trace context.
- Reuse existing safety boundaries: public pages/posts only, no auto-outreach, no private contact inference, existing contact extraction and operator gates remain authoritative.

**Non-Goals:**

- No automated messaging or campaign dispatch from Discovery results.
- No hidden scraping of private pages, closed data, or personal contacts.
- No generic search-provider abstraction beyond keeping the Yandex client isolated.
- No replacement of `BloggerProfile`/`ProfileDataPoint` as the commercial profile source of truth.
- No full semantic vector search over all posts; matching is run-local and evidence-based.

## Decisions

### D1: Add a guided run model instead of overloading `DiscoveryBatch.summary`

Create a first-class persisted guided run shape, either as new Prisma models (`DiscoveryRun`, `DiscoveryRunCandidate`, optional `DiscoveryRunEvent`) or a carefully versioned extension if the implementation chooses to reuse `DiscoveryBatch`. The preferred design is new models because guided discovery has richer lifecycle data than batch discovery: input AJTBD/brief, agent plan, trace events, candidates, evidence posts, recommendation, and operator decisions.

Alternative: keep everything inside `DiscoveryBatch.summary`. Rejected for the guided path because the JSON would become too large and too loosely typed for candidate actions, list filtering, and future auditability. `DiscoveryBatch` can remain the low-level multi-query search job.

### D2: Two new seeded agents

Add `DiscoveryQueryPlanner` (`discovery_query_planner`) and `BloggerDiscoveryReviewer` (`blogger_discovery_reviewer`).

`DiscoveryQueryPlanner` receives campaign goal/AJTBD or a manual brief, platform constraints, geography/language hints, and max query/candidate budgets. It returns multiple search queries with rationale, negative terms, platform targets, and expected signal.

`BloggerDiscoveryReviewer` receives candidate channel/profile data plus recent public posts and the original AJTBD/brief. It returns fit score, recommendation, rationale, evidence posts, risk notes, and next action. The reviewer must cite only supplied public posts/channel data and must not invent reach, contacts, or commercial facts.

Alternative: use `BloggerMatcher` directly. Rejected as the only agent because `BloggerMatcher` scores already-profiled catalog rows; guided discovery also needs query planning and evidence over newly found channels/posts before full profile extraction is complete.

### D3: Orchestrate in an asynchronous worker

`POST /discovery/guided` creates a run and enqueues a `guided-discovery` worker. The worker:

1. Resolves campaign goal/AJTBD when `campaignId` is supplied, or uses the operator's manual brief.
2. Runs `DiscoveryQueryPlanner`.
3. Executes Yandex Search for planned queries through existing `YandexSearchClient`/`buildDiscoverySearchQueries`.
4. Normalizes and dedupes candidates through `extractCandidates`.
5. Upserts or reuses `Channel` rows and enqueues/synchronously waits only within bounded budgets for scrape data already available or just produced.
6. Loads `Channel` snapshot fields, recent public posts, `BloggerProfile` when present, and profile/contact extraction status.
7. Runs `BloggerDiscoveryReviewer` for candidates that have enough public evidence.
8. Persists the shortlist and trace events after every stage.

Alternative: keep guided discovery synchronous in the API. Rejected because LLM planning + web search + scraping + candidate scoring can exceed request budgets and needs live progress.

### D4: Trace events are a product surface, not just logs

Store sanitized trace events as part of the run detail: `planner.started`, `planner.completed`, `search.started`, `search.completed`, `candidate.normalized`, `scrape.queued`, `scrape.completed`, `review.started`, `review.completed`, `candidate.recommended`, and `error`. Events include timestamps, stage status, query text, counts, candidate ids/handles, and short rationale, but never API keys, raw secrets, or private payloads.

Alternative: rely on worker logs. Rejected because operators need to debug "why did we get these bloggers?" directly from the Discovery tab.

### D5: UI becomes a dense operator workbench

The Discovery route should keep the feature-gate behavior but replace the empty form/table feel with:

- an input panel that can select a campaign or paste a manual AJTBD/brief;
- planned-query preview once the planner finishes;
- live trace timeline/log;
- candidate cards/table with fit score, recommendation, platform, title, followers/views where known, status badges, and risk notes;
- expandable evidence posts with text snippets, URLs/dates, and "why this post matched";
- actions to open channel detail/profile, refresh scrape, save/shortlist, and continue into the existing blogger catalog/matching/agency workflow.

This should remain utilitarian and information-dense; no marketing/hero layout.

## Risks / Trade-offs

- [Search/query drift] Yandex search results vary over time -> Persist exact planned queries and trace counts so runs remain auditable.
- [LLM query spam or irrelevant expansion] Planner may generate broad/noisy queries -> enforce max query count, platform scope, negative terms, deterministic validation, and reviewer scoring before showing recommendations as high-confidence.
- [Slow scrape/enrichment] New channels may not have posts immediately -> candidate status must show `needs_scrape`/`pending_enrichment` and still allow re-run/refresh without blocking the whole run.
- [Cost growth] Planning and reviewing many candidates can be expensive -> budget caps per run: max planned queries, max search results per query, max candidates reviewed, token limits, and `agent_run` cost tracking.
- [Data leakage] Trace events could accidentally include secrets or too much raw payload -> store sanitized event shapes and never persist API keys or raw integration config.
- [Schema churn] New run/candidate tables add migration complexity -> keep the first migration narrow and avoid changing `BloggerProfile` identity semantics.

## Migration Plan

1. Add DB models/migration for guided discovery runs, candidates, and trace events, or a versioned compatible extension if implementation proves that sufficient.
2. Add shared zod schemas and queue payload schemas for guided runs, candidates, evidence posts, trace events, and operator actions.
3. Add agent classes and seed defaults; bump the seed version so existing deployments receive `discovery_query_planner` and `blogger_discovery_reviewer`.
4. Add the worker and API endpoints behind the existing `channel_discovery` flag.
5. Update the Discovery UI to use guided runs while leaving low-level single/batch search available as an advanced/debug fallback if useful.
6. Backfill is not required; existing `DiscoveryBatch` rows remain readable by the old batch status page or can be shown under "legacy runs".
7. Rollback: disable `channel_discovery` or hide guided endpoints; no outbound messages are created by this feature, so rollback only stops new discovery runs.

## Open Questions

- Should guided discovery be tied to a `Campaign` row first, or is a standalone manual AJTBD/brief enough for v1? Proposed v1 supports both, with `campaignId` preferred.
- Should "save/shortlist" create a new first-class shortlist table or reuse `BloggerProfile`/`MatchResult`? Implementation should choose based on the smallest schema that preserves operator decisions.
- How long should the worker wait for newly queued `channel-scrape` before scoring? Proposed v1 uses a bounded wait and marks the rest `needs_scrape`.
