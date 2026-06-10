## Why

Offer prices are now first-class rows (`placement-offer-table`), but they are still not **comparable**: a USD price and a RUB price meet the brief budget as raw numbers (no exchange rates anywhere in the system); «от 118 000» and «5–7к» collapse to a single number losing the range; and there is no cost-per-reach metric, so «дешевле за охват» — the operator's main comparison axis — cannot be ranked. This change makes every offer carry normalized, comparison-ready values while the raw values stay untouched on the row.

## What Changes

- **Exchange-rate store.** New `exchange_rate` table (`currency`, `rateToRub`, `asOf`, `source`, `updatedById`), empty at seed and maintained by admin in Settings (empty-state prompts for USD/EUR). It holds the **current** rate per currency (an edit overwrites); historical traceability lives on each offer row via `fxRateUsed`/`fxAsOf` stamps, so stored normalizations stay explainable after rate edits. Until a rate is set, non-RUB offers simply stay unnormalized (visible, excluded from RUB comparisons). No external rate API in v1.
- **RUB-normalized price columns.** `placement_offer` gains `priceRubMin`, `priceRubMax`, `fxRateUsed`, `fxAsOf`, filled at write time by a pure `normalizeOffer()` step in `packages/shared` (RUB offers copy as-is). A recompute job re-derives these columns for `active` rows when a rate changes — raw columns are never rewritten.
- **Price ranges from the extractor.** `PlacementOfferDraftZ` gains optional `price_min`/`price_max`; deterministic parsers and the LLM prompt emit «5–7к» → 5000/7000 and «от 118 000» → min=118000, max=null (open-ended). Legacy `price` stays = min for compatibility. The literal text remains in `rawPrice`.
- **CPM (cost per mille).** `placement_offer` gains `cpmRub` + `viewsBasis`/`viewsSource`: `cpmRub = priceRubMin / views × 1000`, where views = median views of recent posts on the offer's platform from `BloggerPostInsight`, falling back to profile `avgViews`. Recomputed on post-insight refresh and fx change.
- **Matching compares in RUB.** Budget prefilter/score uses `priceRubMin` (was: raw `price`); CPM and the fx context join `fitSignals` and the rationale. Score weights are unchanged — CPM informs, it does not yet re-rank.
- **Duration follow-up: no new mechanism needed.** The registry already marks `duration` as `requiredForKinds: ['post']` and the planner already chases missing required attributes for priced offers when `structured_placement_offers` is on (`buildPlannerPlacementInputs` reads active registry keys). This change only adds a regression test pinning that behavior and documents that enabling the flag in prod is what activates the follow-up — no campaign-config machinery is introduced.

## Capabilities

### New Capabilities

- `price-normalization`: exchange-rate store, RUB-normalized offer columns, deterministic normalization/recompute semantics, price ranges, CPM derivation.

### Modified Capabilities

- `placement-offer-store`: rows gain normalized columns (`priceRubMin/Max`, `fxRateUsed`, `fxAsOf`, `cpmRub`, `viewsBasis`, `viewsSource`) and `priceMax=null` is defined as an open-ended «от»-range; normalization never mutates raw columns.
- `placement-offer-entities`: extractor contract emits `price_min`/`price_max`; «от»-prices are no longer coerced to an exact single number.
- `blogger-matching`: budget fit evaluates `priceRubMin` in RUB; `fitSignals` carries CPM and fx provenance; deterministic order unchanged otherwise.

## Impact

- **DB migration `9g_price_normalization`**: `exchange_rate` table (no seed rows); new nullable columns on `placement_offer`; index on `(cpmRub)` partial where status='active'.
- **packages/shared**: `normalizeOffer()` (pure, unit-tested: fx math, range parsing, CPM); `schemas/placement-offer.ts` ranges; range parsers in `blogger-profile-enrichment.ts` («5–7к», «от X», «до X»).
- **packages/agents**: `RateCardExtractor` prompt + output schema emit ranges; tolerant per-element validation unchanged.
- **apps/workers**: `profile-extract` calls `normalizeOffer()` before row write; new `offer-renormalize` queue triggered by rate change and post-insight refresh.
- **apps/api**: Settings → Exchange rates admin CRUD (admin-only); blogger-profile read exposes normalized values alongside raw.
- **apps/web**: Settings page for rates; profile/catalog show ₽-normalized price + CPM with «по курсу от <даты>» hint.
- **Compatibility**: all new columns nullable; profiles without fx-relevant offers unaffected; matching output identical for all-RUB catalogs with no ranges (regression fixture).
