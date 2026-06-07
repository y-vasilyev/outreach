## Why

Operators using the blogger catalog need to decide quickly whether a creator is relevant to a campaign's AJTBD/agency goal, but the current profile view is optimized around extracted commercial facts rather than fast fit assessment. They also need a compact way to inspect a blogger's strongest recent posts with post-level metrics from ScrapeCreators and Telegram parsing, so relevance is based on observed content and engagement, not only profile rollups.

## What Changes

- Add AJTBD/brief-aware catalog cues that explain why a blogger is relevant or weak for the current campaign goal.
- Add a top-posts preview in catalog/profile screens with post text/media context, source, publish time, and metrics that can be collected from ScrapeCreators and Telegram parsing.
- Add API/schema support for post insight summaries attached to blogger profiles, including provenance/freshness so operators know whether metrics are current enough to trust.
- Add filtering/sorting affordances for fast triage: relevance score, freshness, topic/audience fit, available ad formats, and top-post performance.
- Keep this as an operator decision-support surface; it does not change outreach compliance, auto-send behavior, or the requirement that commercial actions stay operator-controlled.

## Capabilities

### New Capabilities

- `blogger-catalog-insights`: AJTBD/brief-aware catalog and profile UI/API behavior for fast relevance assessment, including top-post previews with source metrics.

### Modified Capabilities

- `blogger-commercial-profile`: Profile detail responses expose recent/top post insight data with provenance and freshness alongside existing commercial profile fields.
- `blogger-matching`: Match results expose the AJTBD/brief fit rationale fields needed by the catalog UI, so operators can understand relevance without opening each profile.

## Impact

- Web: `apps/web/src/features/agency/BloggerCatalogPage.vue`, `BloggerProfilePage.vue`, `MatchPage.vue`, agency types/tests, and related UI components for filters, relevance badges, and top-post previews.
- API: `apps/api/src/routes/blogger-profiles.ts`, `apps/api/src/services/blogger-profiles.ts`, and blogger profile response schemas.
- Workers/integration: ScrapeCreators ingestion in `apps/workers/src/services/scrape-creators.ts`, Telegram parsing in `apps/workers/src/queues/channel-scrape.ts` / profile extraction paths, and provenance mapping for post metrics.
- Shared/db: `packages/shared/src/schemas/blogger-profile.ts`, profile rollup/enrichment helpers, and Prisma schema/migrations if post insights need persisted normalized records.
- Tests: targeted API, worker, shared rollup, and agency UI tests covering AJTBD relevance cues, top-post ordering, metric freshness, and legacy profiles with no post metrics.
