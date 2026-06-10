## Context

`GET /blogger-profiles` supports only `limit/offset/campaignId/briefId`; the Vue catalog filters tabs/platform/format/text client-side over the loaded page, and `apps/api/src/services/matching.ts` stage-1 loads all profiles ordered by `updatedAt` and shortlists in JS. After `placement-offer-table` + `price-normalization-v2`, the data to query lives in indexable columns (`platform`, `kind`, `priceRubMin`, `cpmRub`, `capturedAt`, `status`), so this change is plumbing: one shared filter builder, two consumers (catalog list, matching pre-cut), one UI surface.

Constraints: responses with no new params must stay byte-identical (the catalog and e2e tests depend on it); matching scoring semantics are regression-pinned (all-RUB fixture from `price-normalization-v2`); the catalog is currently ~hundreds of rows, so this is about correctness/testability of search semantics first, scale second.

## Goals / Non-Goals

**Goals:**

- One shared, unit-tested filter→Prisma-`where` builder so catalog and matching cannot diverge on what «подходит под фильтр» means.
- The operator's core query expressible in one GET: platform+kind+price-cap (or CPM-cap)+freshness.
- Stale prices visible and labeled, filterable out — not silently equal to fresh ones.
- Matching stage-1 stops loading the full catalog; final candidate sets provably unchanged.
- Ops visibility: how often the rollup falls back to legacy compose, how hard the SQL pre-cut narrows candidates.

**Non-Goals:**

- No keyset pagination (offset is fine at current scale; the builder doesn't preclude it).
- No full-text/topic search changes (stays client-side / existing behavior).
- No score/weight changes in matching; no CPM-based ranking (CPM is filter+sort only).
- No saved searches / operator presets.

## Decisions

### D1. Filter semantics in packages/shared; Prisma compilation in the API layer

`packages/shared` stays Prisma-free (it depends only on zod, and `@nosquare/db` depends on shared — a Prisma builder there inverts the dependency). Split: shared owns `CatalogOfferFiltersZ` (query schema) and the **pure predicate** `offerMatchesFilters(offerLike, filters)` defining the semantics — profile qualifies when at least one `active` offer satisfies ALL offer-level conditions; `apps/api` owns the single `offerFilterWhere()` module compiling those filters to a Prisma `some`-relation fragment, used by both the catalog service and the matching pre-cut. A parity test feeds the same fixtures through the pure predicate and the compiled query (real Postgres) and asserts identical verdicts — semantics tested once, drift impossible. Alternative — each service builds its own query — rejected for the same drift reason.

Price filter semantics: `priceRubMax` matches `priceRubMin <= :max`, OR (`priceRubMin IS NULL AND priceMin <= :max AND currency='RUB'`) — the same raw-fallback rule matching uses, so an unnormalized RUB row behaves identically everywhere.

### D2. Sort by best matching offer via aggregate subquery

`sort=price_asc|cpm_asc` orders profiles by `MIN(priceRubMin)`/`MIN(cpmRub)` across their active offers **that satisfy the current filters** (not across all offers — sorting by an offer the filter excluded would look broken to the operator). Implemented as a grouped aggregate the service merges with the profile page query; `updated` stays the plain default. NULLs sort last (profiles without normalized values don't float up).

### D3. Staleness is a label computed from existing TTLs, filter is explicit

`staleAfterDays = PROFILE_FIELD_TTL_DAYS.rateCards` (the freshness registry already used by the HUD) applied to offer `capturedAt`. Responses label each offer and the profile's best-offer row `fresh|stale`; `offerFreshDays=N` filters at SQL level (`capturedAt >= now()-N days`). Default keeps stale rows visible — hiding data the operator paid dialogue turns to collect is worse than showing it with a badge. Alternative — exclude stale by default — rejected for that reason; matching likewise keeps its existing freshness behavior (no change in this change).

### D4. Matching pre-cut is a superset guarantee, not a replacement

Stage-1 becomes: SQL pre-cut on offer-level conditions derivable from the brief (platform from brief target platform if any, kind from requested formats, `priceRubMin <= budget`), with two hard inclusion rules that protect the legacy paths from false exclusion:

1. **Profiles with zero active offer rows are ALWAYS included** in the pre-cut result — matching falls back per-profile to legacy `rateCards` for them (`matching.ts` structured-path fallback), and an offer-level SQL condition must not silently drop a candidate the in-memory shortlist would have evaluated via rate cards.
2. **`structured_placement_offers` flag off ⇒ no pre-cut at all** (full scan exactly as today); the pre-cut activates only on the structured path.

The in-memory `isShortlisted` then runs unchanged over the pre-cut set. Invariant: pre-cut ⊇ final shortlist — proven by a property-style integration test that runs both old (full scan) and new (pre-cut) paths over seeded fixtures and asserts identical final candidate sets and order, with fixtures explicitly covering: flag off, flag on + profile with offers, flag on + legacy-only profile (rateCards, no offer rows), and mixed catalogs. If the pre-cut can't express a brief condition safely (e.g. topic overlap), it simply doesn't filter on it. This keeps all scoring/edge semantics in one place (`packages/shared/src/matching.ts`) and makes the SQL layer purely an optimization with a correctness proof.

### D5. Counters as pino structured logs, not new infra

`catalog_query` (filters used, result count, duration), `prefilter_cut` (catalog size, pre-cut size, final shortlist size), `rollup_source` (table vs legacy fallback — closing the observability promise from `placement-offer-table`). Plain `pino` fields under existing logging conventions; no metrics stack added.

### D6. UI: server filters for offer facts, client filters for text

The filter bar's new controls (platform, kind, price-max ₽, CPM-max, freshness toggle, sort) refetch with query params; the existing free-text/topic search stays client-side over the fetched page. «Load more» pagination keeps offset semantics. Compare view renders `priceRubMin–Max`/CPM with «по курсу от <даты>» and stale badges — read-only consumption of fields the API already returns after `price-normalization-v2`.

## Risks / Trade-offs

- [Filter on offers + offset pagination can feel inconsistent as data changes between pages] → accepted at current scale; the builder is keyset-ready if it becomes real.
- [`some`-relation queries with aggregates can produce poor plans as the table grows] → indexes from 9f/9g cover the predicates; integration test EXPLAINs the two hot queries and fails on seq-scan over `placement_offer` above a row threshold.
- [Pre-cut bug silently shrinks match candidates] → superset parity test (D4) runs in CI on every change to the builder or matching; `prefilter_cut` counter makes a production discrepancy visible (final > pre-cut is impossible by construction; pre-cut ≪ catalog with empty brief conditions is a red flag).
- [Two sources of truth during transition (client still filters some facets)] → facet split is explicit: offer-facts = server, text/topic = client; no facet is filtered in both places.

## Migration Plan

1. Deploy API+shared (new params are additive; no params ⇒ old behavior).
2. Deploy web with the new filter bar.
3. Watch `prefilter_cut`/`catalog_query`/`rollup_source` for a few days.
4. Rollback: revert web (API params unused), or revert API (UI controls 400 → hidden behind the existing graceful-error toast). No data changes anywhere.

## Open Questions

- None blocking. (Keyset pagination and CPM-as-ranking deliberately deferred; both have noted extension points.)
