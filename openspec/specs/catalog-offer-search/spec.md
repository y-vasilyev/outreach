# catalog-offer-search Specification

## Purpose
TBD - created by archiving change catalog-sql-search. Update Purpose after archive.
## Requirements
### Requirement: Offer-level filters execute in SQL with shared semantics

`GET /blogger-profiles` SHALL accept `platform`, `kind`, `duration`, `priceRubMax`, `cpmRubMax`, `offerFreshDays`, `hasOffers` and execute them as database queries over `active` `placement_offer` rows. Filter semantics SHALL be defined once as a pure predicate in `packages/shared` (Prisma-free) and compiled to SQL in a single API-layer module used by both the catalog service and matching's pre-cut; a parity test SHALL prove predicate and compiled query agree. A profile matches when at least one of its active offers satisfies ALL offer-level conditions together. `priceRubMax` SHALL match `priceRubMin <= max`, falling back to raw `priceMin` for unnormalized RUB rows. With no new params the response SHALL be byte-identical to the pre-change endpoint.

#### Scenario: The operator's core query is one request

- **WHEN** the catalog is queried with `platform=telegram&kind=post&priceRubMax=50000&offerFreshDays=60`
- **THEN** only profiles having an active Telegram post offer at ≤50 000 ₽ captured within 60 days are returned, filtered in SQL (no full-catalog scan in app code)

#### Scenario: Conditions must hold on one offer, not across offers

- **WHEN** a profile has a Telegram offer at 80 000 ₽ and an Instagram offer at 30 000 ₽ and the query is `platform=telegram&priceRubMax=50000`
- **THEN** the profile is NOT returned (no single offer satisfies both conditions)

#### Scenario: No params — no behavior change

- **WHEN** the endpoint is called with only the pre-existing params
- **THEN** the response is byte-identical to the pre-change implementation

### Requirement: Sorting by best matching offer

The endpoint SHALL support `sort=price_asc|cpm_asc|updated` (default `updated`). Price/CPM sorts SHALL order profiles by the minimum `priceRubMin`/`cpmRub` among their active offers that satisfy the current filters; profiles whose qualifying offers lack the sorted value SHALL sort last.

#### Scenario: Price sort respects active filters

- **WHEN** sorting by `price_asc` with `platform=telegram`
- **THEN** each profile's sort key is its cheapest qualifying Telegram offer, not its cheapest offer overall

### Requirement: Stale offers are labeled, filterable, never silently hidden

Offers older than the rate-card freshness TTL SHALL be labeled `stale` in list/detail/compare responses. `offerFreshDays` SHALL exclude them at SQL level when given. Without the param, stale offers and profiles SHALL remain visible with the label.

#### Scenario: Stale price visible with badge

- **WHEN** a profile's only price is 8 months old and no freshness filter is set
- **THEN** the profile appears with the offer marked `stale`

### Requirement: Search and rollup observability

The system SHALL log structured counters: `catalog_query` (filters, result count, duration), `prefilter_cut` (catalog size, pre-cut size, final shortlist size), and `rollup_source` (offers composed from the table vs the legacy data-point fallback), under existing pino field conventions.

#### Scenario: Fallback composes are visible in ops

- **WHEN** a profile's `placementOffers` is composed via the legacy fallback path
- **THEN** a `rollup_source=legacy_fallback` log entry identifies the profile

