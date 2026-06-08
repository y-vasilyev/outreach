## Why

Bloggers reply to agency_sourcing outreach with prices/reach in free-form Russian, but the catalog populates **unstably**: facts that already have a representation are silently dropped. The operator's core job — collect a high-quality blogger base *fast* — is blocked by extraction that loses data on layouts and edge cases it should already handle. This change stops the bleeding without any new schema fields or DB migration; richer representation, OCR, re-run/markup, and UI are separate follow-up changes.

## What Changes

- **Tolerant per-element validation.** Today `invokeJson` validates the whole extractor payload with one `ProfileExtractionOutputZ.parse()`; a single bad element (price as the string `"от 118000"`, `confidence>1`, a novel enum) throws and — after one repair shot — loses **every** fact from the message. Switch to validating each `data_points[]` / `placement_offers[]` / `attribute_proposals[]` element independently: drop only the malformed element (logged), keep the rest.
- **Coerce prices instead of rejecting them.** `PlacementOfferDraftZ.price` and the draft data-point value accept `"от 118000"`, `"118 000"`, `"1.2млн"`, `"50к"` by coercion rather than failing validation.
- **Structured offers become the canonical write path.** `placement.offer` rows and `BloggerProfile.placementOffers` are **always** persisted and rolled up — no longer gated behind the `structured_placement_offers` flag being on. The profile read API already exposes `placementOffers` unconditionally (`blogger-profiles.ts` `withPresentation()`); that stays. The flag is repurposed to govern **matching/planner preference** only (whether fit-scoring and the data-collection planner prefer structured offers over legacy cards) — still default-off per convention. The catalog is thus structurally complete regardless of flag state. **BREAKING** (internal): flag semantics change from "persist + roll up structured offers" to "prefer structured offers in matching/planner".
- **Deterministic parser fixes** (no schema change): `млн`/`млрд` price multiplier; recognise `МАХ`/MAX, `Дзен`/Zen, `ТГК`→telegram as promoted `platform` strings; parse comma-separated per-format price pairs on one line (`Фото-пост 120000, Видео-пост 170000`); capture `час топа`/`72ч` duration ladders as separate offers with the precise tier in the free-form `notes` attribute; emit **multiple** `tax` attributes for stacked taxes (`8% ИП` + `3% реклама`).
- **Confidence-floor roll-up across all comparable commercial views.** The standardized comparable views — both `placementOffers` **and** the legacy `rateCards`/`formats` derived for compatibility — exclude commercial facts below a configurable confidence floor, so a sub-floor offer cannot leak back via the legacy rate-card path. Nothing is deleted from the data-point rows (low-confidence flagged, not silently dropped). HUD/staleness continues to reflect *raw observation* freshness (existing semantics), independent of the comparable-view floor.
- **Acceptance fixtures.** The five real failing replies become unit-test fixtures; each must land its representable facts losslessly (facts that need new fields are explicitly deferred and asserted as out-of-scope).

## Capabilities

### New Capabilities

_None — this change hardens existing behavior; no new capability is introduced._

### Modified Capabilities

- `placement-offer-entities`: tolerant per-element validation, price coercion, multiple `tax` attributes per offer, and a confidence-floor rule for the rolled-up comparable view.
- `agency-sourcing-pipeline`: structured placement-offer persistence + roll-up is unconditional (canonical write path); the `structured_placement_offers` flag governs read/match preference only.
- `blogger-commercial-profile`: `BloggerProfile.placementOffers` is always populated from `placement.offer` data points regardless of flag state.

## Impact

- **packages/agents**: `_runtime.ts` (tolerant element-wise assembly, strict→repair→tolerant order), `RateCardExtractor` (price coercion for legacy `rate.*` data-point values via the shared normalizer, multi-tax attributes).
- **packages/shared**: `blogger-profile-enrichment.ts` (млн/млрд multiplier, МАХ/Дзен/ТГК platforms, comma-pair inline parser, час-топа ladders, multi-tax); `schemas/placement-offer.ts` (price coercion via `z.preprocess`); `profile-rollup.ts` (confidence floor on `placementOffers` **and** legacy `rateCards`/`formats`); `placement-offers.ts` (a `getOfferAttributes` multi-value accessor for repeatable keys like `tax`); `matching.ts` (collect all `tax` attributes in `placement_terms`).
- **apps/workers**: `profile-extract.ts` — un-gate structured persistence/roll-up so it always runs; flag now only affects downstream matching/planner preference (`agent-run.ts` planner inputs).
- **Compatibility**: legacy `rateCards`/`formats` remain populated (derived); no DB migration; no API shape change. Existing tests that asserted "flag off ⇒ no placement offers persisted" must be updated to the new canonical-write semantics.
- **Out of scope (follow-up changes)**: per-platform audience, package/tariff/slot/price_period/prepayment/tax-regime fields and the duration enum extension (`placement-representation-v2`); attachment OCR (`attachment-ocr-ingestion`); operator re-run/markup/correction (`operator-reanalyze-and-markup`); profile UI + post images (`blogger-profile-who-is-this`).
