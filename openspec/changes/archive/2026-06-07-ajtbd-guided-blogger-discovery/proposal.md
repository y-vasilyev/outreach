## Why

The current Discovery page is a thin web-search intake: an operator types a niche, receives raw channel handles, and cannot see why they were found, which queries were tried, or whether the channels actually fit the campaign's AJTBD/brief. This makes the tab operationally weak for agency sourcing because it discovers "some channels" instead of producing a reviewable shortlist of relevant bloggers with evidence.

## What Changes

- Add an LLM-guided discovery planning step that expands a campaign AJTBD or free-form niche into multiple search queries, platform constraints, negative terms, and rationale.
- Extend discovery runs from "Yandex results -> channel rows" into a traceable pipeline: planned queries, web-search results, candidate normalization, scrape/enrichment, fit scoring, and operator-visible logs.
- Seed new multiagent defaults for discovery planning and blogger recommendation, wired through `agent_config` and compatible with the existing endpoint/fallback model.
- Reuse the existing Yandex Search integration for web search and the existing scrape/contact/profile path for channel data, but return an enriched shortlist with blogger cards, matching posts, fit explanations, and system recommendations.
- Upgrade the Discovery UI from a passive form/table into an AJTBD-driven workbench where operators can inspect runs, click candidate bloggers, inspect matching posts, queue/refresh scraping, and add/save shortlisted bloggers for downstream agency workflows.
- Preserve safety/compliance: only public pages/posts and publicly visible channel data are used; discovery does not auto-message contacts and does not bypass existing channel/contact extraction gates.

## Capabilities

### New Capabilities

- `ajtbd-blogger-discovery`: LLM-guided blogger discovery workbench: query planning, run trace, enriched candidate evaluation, matching post evidence, and operator actions.

### Modified Capabilities

- `channel-discovery`: Existing Yandex channel discovery becomes the lower-level web-search/intake layer used by guided discovery, and its batch/status responses must expose enough trace metadata for operator diagnostics.

## Impact

- `packages/agents`: new agents for discovery query planning and blogger recommendation/scoring, with schemas and tests.
- `packages/db/prisma/agents.seed.ts` and `packages/db/prisma/seed.ts`: seed version bump and default `agent_config` rows for the new agents.
- `packages/platforms/src/discovery`: reusable web-search/query execution primitives remain Yandex-backed and must support traceable multi-query runs.
- `apps/api`: new or extended discovery endpoints for guided runs, run detail, candidate detail, and operator actions.
- `apps/workers`: asynchronous guided-discovery worker that orchestrates agents, web search, scraping/enrichment, scoring, and run summary persistence.
- `packages/shared/src/schemas/discovery.ts`: request/response schemas for guided discovery runs, trace events, candidate cards, post evidence, and recommendations.
- `apps/web/src/features/discovery`: Discovery page and batch-status page become an operator workbench with AJTBD input, live run log, shortlist/cards, matching posts, and click-through actions.
- Database schema: likely new persistent run/candidate tables or an extension of `DiscoveryBatch.summary` to store agent plan, trace events, enriched candidates, evidence, and recommendations.
