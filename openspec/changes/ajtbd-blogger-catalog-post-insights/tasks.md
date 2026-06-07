## 1. Data Model And Shared Contracts

- [x] 1.1 Add a Prisma migration/model for `BloggerPostInsight` with profile/channel links, platform post identity, normalized metrics JSON, source, metric capture timestamp, and dedupe indexes.
- [x] 1.2 Extend `MatchResult` persistence with structured fit metadata (`fitSignals`/score breakdown and `evidencePostIds`) while preserving existing `score`, `rationale`, and `rerankedByLlm` fields.
- [x] 1.3 Add shared zod schemas/types for post insights, metric freshness, top-post preview, catalog fit, and match fit breakdown in `packages/shared`.
- [x] 1.4 Add shared deterministic helpers for post metric freshness, top-post `performanceScore`, and context-fit signal assembly.

## 2. Post Insight Ingestion

- [x] 2.1 Extend `packages/platforms/src/scrapecreators/Client.ts` to normalize available Instagram/YouTube post metrics from lenient raw field names, with fixture tests.
- [x] 2.2 Add a worker-side upsert service that maps ScrapeCreators IG/YT posts into `BloggerPostInsight` rows without exposing raw upstream payloads through public APIs.
- [x] 2.3 Extend Telegram public channel scrape/parsing to capture public post id/date/text and available views/forwards/reactions into post insights.
- [x] 2.4 Add an explicit post-insight refresh job/action for supported profile sources and pending/error status handling.
- [x] 2.5 Ensure ingestion stores empty metrics honestly when a source has text/date but no reliable metric fields.

## 3. API And Matching Behavior

- [x] 3.1 Extend blogger profile list/detail serializers to include bounded `topPostsPreview`, detail `postInsights`, metric freshness, and provenance.
- [x] 3.2 Add catalog query validation for mutually exclusive `campaignId`/`briefId` and explicit errors for invalid/missing campaign goals.
- [x] 3.3 Implement deterministic catalog fit for `campaignId` context by resolving campaign type goal (AJTBD for `custdev`, agency goal for `agency_sourcing`) without mutating campaign data.
- [x] 3.4 Reuse persisted match results for `briefId` context when available, with deterministic fallback that does not create a new match run.
- [x] 3.5 Extend matching service responses and persistence to include structured fit breakdown and stored post evidence ids.
- [x] 3.6 Add API route/service support for requesting asynchronous post insight refresh.

## 4. Agency UI

- [x] 4.1 Extend `apps/web/src/features/agency/types.ts` and API usage for `fit`, `topPostsPreview`, `postInsights`, metric freshness, and refresh status.
- [x] 4.2 Update `BloggerCatalogPage.vue` with campaign/brief context selection, relevance sorting, fit rationale/gap display, and top-post metric preview.
- [x] 4.3 Add catalog filters for relevance context, platform/topic/language/format, commercial readiness, metric freshness, and profiles with usable top-post metrics.
- [x] 4.4 Update `BloggerProfilePage.vue` with a top-post insights section showing post snippets, metrics, source, freshness, and related fit evidence.
- [x] 4.5 Update `MatchPage.vue` to render structured fit breakdown and linked post evidence from match results.
- [x] 4.6 Render empty, stale, unavailable, pending refresh, and unsupported-source states without hiding the profile.

## 5. Tests And Validation

- [x] 5.1 Add shared helper tests for metric freshness, performance scoring, and fit signal assembly.
- [x] 5.2 Add API tests for profile list/detail post insights, `campaignId`/`briefId` context validation, context-free compatibility, and legacy profiles with no post insights.
- [x] 5.3 Add matching tests for persisted fit metadata, evidence post ids, and LLM rerank preserving deterministic evidence.
- [x] 5.4 Add worker/platform tests for ScrapeCreators metric normalization and Telegram public post metric upserts.
- [x] 5.5 Add agency UI tests for relevance sorting/filtering, top-post previews, profile detail post insights, and stale/missing metric states.
- [x] 5.6 Run targeted package tests/typechecks plus `openspec validate ajtbd-blogger-catalog-post-insights --strict`.
