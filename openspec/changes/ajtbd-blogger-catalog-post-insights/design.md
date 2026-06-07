## Context

The agency catalog already has a standardized `BloggerProfile` rollup with topics, formats, rates, audience, reach, average views, data-point provenance, and freshness. Matching already ranks profiles against an `AdBrief`, and a separate guided-discovery change covers finding new bloggers with evidence posts. This change targets a different operator workflow: browsing the existing catalog and quickly understanding which bloggers are relevant to a current campaign/brief, with top public posts and metrics visible inline.

Current gaps:

- `BloggerProfile` list rows expose commercial profile facts but not post-level evidence.
- ScrapeCreators clients normalize recent IG/YT posts without metric fields, and Telegram channel post metrics are not represented as catalog evidence.
- Catalog/profile reads do not accept a campaign/brief context, so operators must mentally map profile data to AJTBD or agency goals.
- Match results only expose a single rationale string, which is too thin for a dense catalog view with filters, gaps, and evidence.

## Goals / Non-Goals

**Goals:**

- Add a compact `BloggerPostInsight` data model and API shape for public post evidence, metric freshness, and provenance.
- Extend ScrapeCreators and Telegram scraping/parsing paths to upsert public post insights without blocking catalog reads.
- Make `GET /blogger-profiles` optionally context-aware via `campaignId` or `briefId`, returning fit score, positive signals, gaps, and top evidence post ids.
- Render catalog and profile screens so an operator can scan relevance, commercial readiness, and top posts without opening every profile.
- Keep explanations auditable: every displayed metric must identify source, capture time, and public post identity.

**Non-Goals:**

- Do not create or send outreach messages from catalog interactions.
- Do not scrape private data, personal contacts, or hidden platform fields.
- Do not replace guided discovery; discovery still owns finding new candidates and run traces.
- Do not require an LLM on every catalog page load. Catalog fit must have a deterministic path and can reuse persisted match results.

## Decisions

### Persist post insights separately from profile data points

Create a normalized post-insight model instead of storing top posts inside `BloggerProfile` JSON or `ProfileDataPoint`.

Proposed shape:

```ts
{
  id: string,
  profileId: string,
  channelId: string | null,
  platform: string,
  externalPostId: string,
  url: string | null,
  publishedAt: ISODate | null,
  textSnippet: string,
  mediaKind: 'post' | 'story' | 'reels' | 'shorts' | 'video' | 'other',
  metrics: {
    views?: number,
    likes?: number,
    comments?: number,
    shares?: number,
    forwards?: number,
    reactions?: number,
    saves?: number,
    engagementRate?: number
  },
  metricCapturedAt: ISODate,
  source: 'scrapecreators' | 'telegram_public_parse' | 'manual_import',
  sourceRawRef?: string,
  createdAt: ISODate,
  updatedAt: ISODate
}
```

Rationale: post insights are repeatable child rows with their own identity and freshness. `ProfileDataPoint` remains the source for rolled-up commercial facts; using it for many post rows would blur profile rollup provenance with content evidence. The API can still expose post insights on profile detail and list previews.

Alternative considered: add `topPosts` JSON to `BloggerProfile`. Rejected because it is harder to upsert, expire, dedupe across sources, test, and join to match evidence.

### Keep catalog reads side-effect free

Catalog/profile reads return existing post insights and stale/missing states. They MUST NOT call ScrapeCreators, Telegram, or LLMs inline. Refresh actions enqueue existing worker paths and the UI shows `pending_enrichment`/stale states.

Rationale: catalog screens need to stay fast and predictable. Inline scraping would introduce upstream latency, rate-limit failures, and hidden cost into ordinary browsing.

Alternative considered: fetch metrics lazily when an operator opens a profile. Rejected for the first implementation because it makes performance and rate limits hard to reason about; an explicit refresh button is safer.

### Make fit context explicit

`GET /blogger-profiles` accepts at most one of `campaignId` or `briefId`.

- `briefId`: load persisted `AdBrief` and existing/recomputed deterministic match scores.
- `campaignId`: resolve the campaign type goal. For `custdev`, use AJTBD fields; for `agency_sourcing`, use the agency goal fields. Convert that goal into a catalog-fit input shape without mutating campaign data.
- No context: return ordinary catalog rows without fit.

Each context-aware row returns:

```ts
fit?: {
  score: number,
  source: 'deterministic' | 'match_result' | 'llm_rerank',
  rationale: string,
  positiveSignals: string[],
  gaps: string[],
  evidencePostIds: string[]
}
```

Rationale: operators need to know why a blogger fits now, not only whether they were generally good. Keeping `fit` optional preserves existing clients.

Alternative considered: force operators through the Match page. Rejected because catalog browsing is its own workflow: users compare many profiles, filters, and post evidence before deciding whether to run or persist a formal match.

### Extend matching explanation without changing candidate ownership

`MatchResult` should persist richer explanation metadata, such as `fitSignals` JSON and `evidencePostIds`, while keeping `score`, `rationale`, and `rerankedByLlm` as the compatibility surface. `MatchResponse` includes the richer shape; older clients can ignore it.

Rationale: the catalog can reuse persisted match results for `briefId` context, and the Match page can show the same evidence vocabulary.

Alternative considered: compute all fit signals only in memory. Rejected because persisted matches need auditability and stable explanations after a run.

### Rank top posts deterministically

Post previews use a deterministic `performanceScore` derived from available metrics:

- prefer recent public posts with non-stale metrics;
- normalize views against the profile's `avgViews` when available;
- include engagement metrics when a platform exposes them;
- never infer a missing metric from another platform's metric.

The API returns the score only as a UI ordering aid, not as a commercial guarantee. Source metrics remain visible so operators can judge quality.

## Risks / Trade-offs

- [Risk] ScrapeCreators returns platform-specific metric fields with unstable names -> Mitigation: parse leniently, preserve raw snapshots out of the public API, and add fixture tests for IG/YT variants.
- [Risk] Telegram public post metrics may be unavailable for some channels -> Mitigation: store post rows with null metrics and render "metrics unavailable" instead of hiding the post or inventing values.
- [Risk] Context-aware catalog scoring becomes expensive for large catalogs -> Mitigation: reuse deterministic scorer first, cap LLM usage to explicit match runs, and add server-side pagination/sort before broadening limits.
- [Risk] Operators over-trust stale viral posts -> Mitigation: expose `metricCapturedAt`, freshness state, and sort/filter controls for stale metrics.
- [Risk] Discovery and catalog post evidence drift into duplicate concepts -> Mitigation: discovery candidates can reference `BloggerPostInsight` ids after a profile exists, but discovery run trace/evidence remains owned by guided discovery.

## Migration Plan

1. Add the post-insight table/schema behind the agency sourcing feature surface.
2. Extend shared zod schemas and API serializers while keeping existing fields backward compatible.
3. Add worker upsert paths for ScrapeCreators IG/YT and Telegram public channel parsing.
4. Backfill opportunistically from already scraped public recent posts where enough identity/date data exists; otherwise profiles show no post insights until refresh.
5. Add UI preview sections and filters that tolerate empty `topPostsPreview` and missing `fit`.
6. Roll back by hiding UI affordances and leaving the post-insight table unused; existing profile/matching behavior remains intact.

## Open Questions

- Which ScrapeCreators endpoints expose reliable metrics for Instagram and YouTube in production, and what are their exact raw field names?
- Should the first implementation support VK/TikTok post insights, or only Telegram/Instagram/YouTube where the current code already has adjacent support?
- What is the default metric freshness TTL for top posts: 30 days for engagement-heavy feeds, or 90 days to match rate/reach freshness?
