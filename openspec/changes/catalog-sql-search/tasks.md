## 1. Shared filter builder

- [ ] 1.1 `packages/shared/src/schemas/`: `CatalogOfferFiltersZ` query schema (platform, kind, duration, priceRubMax, cpmRubMax, offerFreshDays, hasOffers, sort)
- [ ] 1.2 `packages/shared/src/catalog-offer-filters.ts`: pure predicate `offerMatchesFilters()` (Prisma-free; price fallback rule for unnormalized RUB); unit tests for every filter + composition
- [ ] 1.3 Staleness labeling helper from `PROFILE_FIELD_TTL_DAYS.rateCards` applied to offer `capturedAt`; unit tests
- [ ] 1.4 `apps/api`: `offerFilterWhere()` compiles shared filters to a Prisma `some`-fragment over active offers; predicate↔query parity test on real Postgres

## 2. Catalog API

- [ ] 2.1 `blogger-profiles` list route + service: accept filters, build query via shared builder, aggregate-subquery sorts (`price_asc`/`cpm_asc` by best qualifying offer, NULLs last)
- [ ] 2.2 Responses label offers/profiles `fresh|stale`; detail/compare payloads carry normalized values + hints (already exposed by `price-normalization-v2` — verify shape)
- [ ] 2.3 Integration tests (real Postgres): core query scenario, per-offer AND semantics, no-params byte-identity, sort-respects-filters, freshness filter
- [ ] 2.4 EXPLAIN-guard test: hot queries use 9f/9g indexes (fail on seq-scan over `placement_offer` beyond threshold)
- [ ] 2.5 `catalog_query` pino counter

## 3. Matching pre-cut

- [ ] 3.1 `apps/api/src/services/matching.ts`: stage-1 SQL pre-cut from brief conditions (platform/format/budget) via `offerFilterWhere()`; ALWAYS includes zero-offer-row profiles (legacy rateCards fallback); no pre-cut when `structured_placement_offers` off; inexpressible conditions skipped; in-memory `isShortlisted` unchanged
- [ ] 3.2 Superset parity test: both paths over seeded fixtures ⇒ identical final candidates + order; fixtures cover flag-off, structured profiles, legacy-only profiles (rateCards/no rows), mixed catalog
- [ ] 3.3 `prefilter_cut` + `rollup_source` counters (closes the `placement-offer-table` observability promise)

## 4. Web UI

- [ ] 4.1 `BloggerCatalogPage.vue`: filter bar controls (platform, kind, max ₽, max CPM, freshness, sort) → query params, refetch, URL-state; text/topic stays client-side
- [ ] 4.2 Rows + compare: normalized price/CPM, stale badges, «по курсу от <даты>» / «≈» hints
- [ ] 4.3 Component tests for filter bar param mapping; e2e happy path «телеграм-посты до 50к свежее 60 дней»

## 5. Docs & rollout

- [ ] 5.1 `DESIGN.md` search semantics; `CHANGELOG.md` operator-visible filters
- [ ] 5.2 Rollout: API → web → watch counters; rollback notes (revert web or API, no data changes)
- [ ] 5.3 `pnpm typecheck && pnpm lint && pnpm test` green
