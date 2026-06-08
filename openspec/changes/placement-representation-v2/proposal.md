## Why

`harden-reply-extraction` stopped the catalog from losing data that already had a representation. But several commercially important facts in real replies still have **nowhere to land**, so two bloggers can't be compared on them — which directly blocks the standalone "collect a base → search & compare" path: per-platform audience sizes, named tariffs with slots, package/bundle prices, base-vs-seasonal pricing, prepayment terms, and the tax regime. This change adds first-class, **comparable** representation for those, so the catalog row carries everything an operator needs to filter and rank bloggers side by side.

## What Changes

- **Per-platform audience sizes.** Add `BloggerProfile.platformAudience` (one entry per platform: `{ platform, subscribers, source, capturedAt }`). `AudienceStatsExtractor` stops discarding subscriber counts and instead emits `audience.subscribers.<platform>` data points; the roll-up composes them into `platformAudience`. A blogger with «Инст 1.2млн, ТГ 15тыс, ВК 45тыс, ТикТок 24.5тыс» becomes comparable per platform instead of collapsing to one `reach`.
- **Placement attribute registry v2.** Extend `PLACEMENT_ATTRIBUTE_REGISTRY_V1` → a v2 set with new active keys: `tariff_name` (string), `slot` (string), `price_period` (enum `base|seasonal|promo`), `prepayment` (string, e.g. «100%», «50/50»), `tax_regime` (enum `ip|self_employed|ooo|none`), `tax_included` (boolean), `top_pin_hours` (number), `package_items` (string_list). **All nine keys have `requiredForKinds: []`** so they never add new planner follow-ups by default (a campaign may opt in later). Package totals stay on the offer itself (`kind=package` + `offer.price`); `package_items` only lists the bundle composition. Existing extraction/proposal/review flow is unchanged; these just become recognized active keys.
- **Slot/tariff no longer collapse — without polluting format keys.** Distinct slots/tariffs at different prices already stay distinct (the dedupe key includes price). For the rare same-price case, `tariff_name`/`slot` are added to the **offer dedupe key** (`collectPlacementOffers`, extractor `pushOffer`) — NOT to `derivePlacementFormatKey`, so the legacy `rate.<format>` strings, the `formats` union, catalog filters, and web labels stay clean and stable (no Cyrillic/spaces leaking into format keys).
- **Deterministic extractors** populate the new keys where the layout is unambiguous (`price_period` from «Цена июня»; `tax_regime`/`tax_included` from «ИП»/«включён»; `top_pin_hours` from the час-топа ladder tiers; `prepayment` from «100% предоплата»; `package_items`/`package_price` from «Пакетное 50 тыс оба формата»). The LLM prompt is updated to emit them too.
- **Matching & catalog read** use the new fields for comparison: per-platform audience and price_period/prepayment/tax surface on the profile read API and feed the brief-match scoring and the standalone compare view.

## Capabilities

### New Capabilities

- `per-platform-audience`: capture and expose per-platform subscriber counts on the blogger profile, composed from data points and used for catalog search/compare.

### Modified Capabilities

- `placement-offer-entities`: registry v2 attribute keys (tariff_name, slot, price_period, prepayment, tax_regime, tax_included, top_pin_hours, package_items) become recognized active attributes (all `requiredForKinds: []`); offer dedupe keys on tariff/slot so same-price distinct slots/tariffs stay distinct (format keys unchanged).
- `blogger-commercial-profile`: profile gains `platformAudience`; read API surfaces it and the new placement terms.
- `blogger-matching`: matching can compare on per-platform audience and prefer the `base` price for budget fit, still behind the existing `structured_placement_offers` preference flag, without losing the legacy path.

## Impact

- **DB migration `9b_placement_representation_v2`**: add `blogger_profile.platform_audience Json default '[]'`. (Migration named to sort after `9a_*` — Prisma lexical ordering.)
- **packages/shared**: `placement-offers.ts` registry v2 (all `requiredForKinds: []`); `profile-rollup.ts` adds tariff/slot to `offerDedupeKey` + composes `platformAudience`; `schemas/blogger-profile.ts` `platformAudience`; `blogger-profile-enrichment.ts` deterministic capture of new keys + tariff/slot in `pushOffer` dedupe; `matching.ts` per-platform audience + base-price budget; `MatchableProfile` carries `platformAudience`.
- **packages/agents**: `AudienceStatsExtractor` emits `audience.subscribers.<platform>` (stop dropping subscribers); `RateCardExtractor` prompt mentions tariff/slot/price_period/prepayment/package; both still tolerant-validated.
- **packages/db**: schema + migration + seed of the v2 registry rows (status active).
- **apps/api**: blogger-profiles read includes `platformAudience` + new terms; catalog list/compare can filter/sort on per-platform subscribers.
- **apps/web**: profile/catalog render per-platform audience and the new terms (full compare UI lands in `blogger-profile-who-is-this`; this change just exposes the data).
- **Compatibility**: legacy `reach`/`avgViews`/`audience` unchanged; `platformAudience` is additive. New registry keys are additive (no removal). No behavior change when a reply states none of them.
