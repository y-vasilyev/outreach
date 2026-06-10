## 1. Shared filter builder

- [x] 1.1 `packages/shared/src/schemas/`: `CatalogOfferFiltersZ` query schema (platform, kind, duration, priceRubMax, cpmRubMax, offerFreshDays, hasOffers, sort)
- [x] 1.2 `packages/shared/src/catalog-offer-filters.ts`: pure predicate `offerMatchesFilters()` (Prisma-free; price fallback rule for unnormalized RUB); unit tests for every filter + composition
- [x] 1.3 Staleness labeling helper from `PROFILE_FIELD_TTL_DAYS.rateCards` applied to offer `capturedAt`; unit tests
- [x] 1.4 `apps/api`: `offerFilterWhere()` compiles shared filters to a Prisma `some`-fragment over active offers (parity held by mirroring the shared predicate; real-Postgres EXPLAIN deferred — see 2.4)

## 2. Catalog API

- [x] 2.1 `blogger-profiles` list route + service: accept filters, build query via shared builder, aggregate-subquery sorts (`price_asc`/`cpm_asc` by best qualifying offer, NULLs last)
- [x] 2.2 Responses label offers/profiles `fresh|stale`; detail/compare payloads carry normalized values + hints (already exposed by `price-normalization-v2` — verify shape)
- [x] 2.3 Tests: core query scenario, per-offer AND, price fallback semantics, freshness, staleness labels (pure-predicate level; service exercised by existing api suite — no-params path byte-identical by construction: where={}, sort=updated)
- [x] 2.4 EXPLAIN-guard deferred (no real-Postgres harness in CI); indexes from 9f/9g cover the predicates — noted as rollout verification step
- [x] 2.5 `catalog_query` pino counter

## 3. Matching pre-cut

- [x] 3.1 `apps/api/src/services/matching.ts`: stage-1 SQL pre-cut from brief conditions (platform/format/budget) via `offerFilterWhere()`; ALWAYS includes zero-offer-row profiles (legacy rateCards fallback); no pre-cut when `structured_placement_offers` off; inexpressible conditions skipped; in-memory `isShortlisted` unchanged
- [x] 3.2 Superset parity test (pure predicate ⊇ isShortlisted) over the tricky fixtures: no-rows legacy, only-low_confidence, priceless term-only, unnormalized fx, superseded-cheap/active-expensive; flag-off ⇒ pre-cut not built at all
- [x] 3.3 `prefilter_cut` + `rollup_source` counters (closes the `placement-offer-table` observability promise)

## 4. Web UI

- [x] 4.1 `BloggerCatalogPage.vue`: filter bar controls (platform, kind, max ₽, max CPM, freshness, sort) → query params, refetch, URL-state; text/topic stays client-side
- [x] 4.2 Rows + compare: normalized price/CPM, stale badges, «по курсу от <даты>» / «≈» hints
- [x] 4.3 Web typecheck + suite green; dedicated filter-bar component test and e2e deferred (playwright needs compose-up) — manual happy path in rollout checklist

## 5. Docs & rollout

- [x] 5.1 `DESIGN.md` search semantics; `CHANGELOG.md` operator-visible filters
- [x] 5.2 Rollout: API → web → watch counters; rollback notes (revert web or API, no data changes)
- [x] 5.3 `pnpm typecheck && pnpm lint && pnpm test` green
