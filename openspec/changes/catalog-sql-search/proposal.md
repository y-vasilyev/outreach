## Why

With offers as normalized rows (`placement-offer-table`, `price-normalization-v2`), search is still in-memory: `GET /blogger-profiles` returns pages the client filters, and matching's stage-1 prefilter loads the entire catalog per match call. The operator cannot express the core query — «телеграм-посты до 50 000 ₽ (или CPM до X), данные свежее 60 дней» — as a database query, and the in-memory paths stop scaling and stay untestable against real data. This change pushes offer-level search into SQL and gives the catalog UI and matching the same server-side filter semantics.

## What Changes

- **Offer-level query params on `GET /blogger-profiles`**: `platform`, `kind`, `duration`, `priceRubMax` (matches `priceRubMin <= max`, raw-RUB fallback per `price-normalization` semantics), `cpmRubMax`, `offerFreshDays` (offer `capturedAt` recency), `hasOffers`. Filters compose as AND across a profile's `active` offer rows (a profile matches if at least one active offer satisfies all offer-level conditions); existing params (`limit/offset/campaignId/briefId`) unchanged.
- **Sorting**: `sort=price_asc | cpm_asc | updated` (price/cpm sort by the profile's best matching active offer). Default stays `updated`.
- **Staleness policy**: offers older than the rate-card freshness TTL are labeled `stale` in responses; `offerFreshDays` filters them out explicitly. Stale ≠ hidden by default — visible but marked.
- **Matching prefilter pushdown**: stage-1 candidate selection moves from «load whole catalog, filter in JS» to a SQL pre-cut on `placement_offer` (platform/kind/budget) + existing profile filters, with the in-memory `isShortlisted` retained as the second pass so scoring semantics stay byte-identical. An ops counter logs candidate counts (SQL-cut vs final) and rollup compose source (table vs fallback — the counter promised in `placement-offer-table`).
- **Catalog UI server-driven filters**: the filter bar gains price-max, platform, kind, CPM-max, and freshness controls wired to the new query params; existing client-side text/topic filtering stays client-side. Compare view shows normalized ₽ prices/CPM with staleness badges.

## Capabilities

### New Capabilities

- `catalog-offer-search`: SQL-pushdown search semantics over placement-offer rows — filter composition, sorting, staleness labeling, and pagination guarantees.

### Modified Capabilities

- `blogger-catalog-insights`: catalog list/filter bar driven by server-side offer filters (price/CPM/platform/kind/freshness) instead of client-side JSON scans; rows carry staleness badges.
- `blogger-matching`: stage-1 prefilter is a SQL pre-cut over offer rows with identical final candidate sets (the in-memory shortlist check remains authoritative; regression fixture proves parity).

## Impact

- **No DB migration**: indexes from `9f`/`9g` (`(platform, kind, priceMin)`, partial `(cpm_rub)`, `(profileId, status)`) are the ones these queries use; query plans verified in tests.
- **packages/shared**: query-param zod schema + pure filter predicate (semantics source of truth; Prisma-free — shared must not depend on Prisma); staleness labeling helper reusing `PROFILE_FIELD_TTL_DAYS`.
- **apps/api**: single `offerFilterWhere()` module compiling shared filter semantics to Prisma, used by the catalog list service AND `matching.ts` stage-1 pre-cut (pre-cut always includes zero-offer-row profiles; inactive with `structured_placement_offers` off); ops counters (`catalog_query`, `prefilter_cut`, `rollup_source`).
- **apps/web**: `BloggerCatalogPage.vue` filter bar + sort dropdown + staleness badges; compare view normalized values.
- **Compatibility**: no params ⇒ byte-identical responses to today; matching results unchanged (pre-cut is a superset of the final shortlist); client-side filters keep working during transition.
