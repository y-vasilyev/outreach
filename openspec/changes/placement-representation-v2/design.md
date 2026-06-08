## Context

After `harden-reply-extraction`, the catalog reliably captures platforms, per-format prices, duration tiers (in notes), and multi-tax. What still has no comparable home: per-platform audience size (the roll-up keeps one scalar `reach`), named tariffs + slots (collapse in `derivePlacementFormatKey`), package prices (kind=`package` is an opaque blob), base-vs-seasonal price (two undistinguished offers), prepayment, and tax regime (one free-form `tax` string). These are exactly the fields the standalone "search & compare" path needs.

## Goals / Non-Goals

**Goals:**
- Per-platform audience as a first-class, comparable profile field.
- v2 registry keys so tariff/slot/price_period/prepayment/tax_regime/tax_included/top_pin_hours/package_* are typed, not free text.
- Distinct tariffs/slots no longer collapse.
- One additive DB migration; legacy fields untouched.

**Non-Goals:**
- The compare/search UI itself (`blogger-profile-who-is-this`); this change only exposes the data on the read API.
- Re-running extraction / operator correction (`operator-reanalyze-and-markup`).
- Attachment OCR (`attachment-ocr-ingestion`).

## Decisions

### D1 — `platformAudience` as a rolled-up JSON column, composed from data points
Add `blogger_profile.platform_audience Json default '[]'` (migration `9b_…`). `AudienceStatsExtractor` emits `audience.subscribers.<platform>` points (value = number). `rollUpProfileFields` groups those by platform and keeps the latest-high-confidence count per platform → `platformAudience: [{platform, subscribers, source, capturedAt}]`. Rationale: mirrors the existing EAV→rollup pattern (provenance on data points, comparable view on the column); no new table; re-derivable. `source` defaults to `reply` (extractor); a future change can add `scrapecreators`.
- **Alternative**: a separate `audience_stat` table. Rejected — overkill for a small per-platform map; the JSON column matches `placementOffers`/`audience` precedent.

### D2 — Registry v2 = extend the constant + seed rows, no schema change for attributes; ALL requiredForKinds: []
Attributes live in offer `attributes[]` JSON; "active registry" = `PLACEMENT_ATTRIBUTE_REGISTRY_V1` constant ∪ approved DB rows. Add the eight v2 entries to the constant (keep the exported symbol name to avoid churn) and seed them as `status='active'`. **Every v2 key has `requiredForKinds: []`.** Rationale (codex): `requiredForKinds` drives `missingRequiredAttributes` → the worker passes active required keys to the `DataCollectionPlanner` (`agent-run.ts:471-474`), which prioritizes attribute follow-ups (`DataCollectionPlanner.ts:337-356`). A non-empty `requiredForKinds` on a v2 key would silently make the live dialogue start asking for it. Keeping them all `[]` means v2 is purely a representation/comparison change; a campaign can opt a key in later. A planner regression test asserts v2 adds no new follow-ups by default.

### D3 — Distinguish tariff/slot in the OFFER dedupe key, NOT the format key
Codex flagged that appending tariff/slot to `derivePlacementFormatKey` (a) leaks Cyrillic/spaces/long names into `formats`/`rateCards`/catalog filters/web labels (`BloggerCatalogPage.vue:66`, `BloggerProfilePage.vue:347`) and (b) breaks the legacy-card suppression, which keys on exact `legacy.format === derivePlacementFormatKey(offer)` (`profile-rollup.ts:276,281`; `blogger-profiles.ts:147,151`) — a suffixed structured key would stop suppressing the unsuffixed legacy `rate.<format>` card, duplicating it. So we do NOT touch `derivePlacementFormatKey`. Distinct-price slots already stay distinct (the dedupe key includes price, and `placementOffersToRateCards` dedupes on `format:price:currency`). For the rare SAME-price case, add `tariff_name`/`slot` to `offerDedupeKey` (`profile-rollup.ts:161`) and the extractor's `pushOffer`/`PLACEMENT_DEDUPE` keys. Result: format strings, suppression, and UI labels are byte-identical to today; tariff/slot ride only as comparable attributes + a dedupe discriminator.

### D4 — Deterministic capture is best-effort; LLM is the primary source for v2 keys
The deterministic parser sets the unambiguous ones: `price_period=seasonal` from «цена <месяц>»/«акция», `tax_regime=ip` from «ИП», `tax_included=true` from «включ», `top_pin_hours` from «\d+ ?ч» in a top-pin tier, `prepayment` from «\d+% предоплат». Tariff/slot/package detection is messy in prose → primarily the LLM (prompt updated), with deterministic only for clear «слот N»/«Пакетное <price>». Rationale: avoid false positives in the deterministic layer; the LLM + tolerant validation already handle the long tail.

### D5 — Matching reads new fields additively, behind the existing flag
`matching.ts` gains optional use of `platformAudience` and a base-price budget rule, still behind `structured_placement_offers` (default off — unchanged). Budget price selection (codex): structured matching currently budgets against `Math.min(...relevantPrices)` (`matching.ts:533,608`). The v2 rule: when an offer has multiple `price_period` variants for the same format, use the `base` price; fall back to `seasonal`/`promo` only when no `base` exists — so a 120k base / 135k June pair budgets on 120k, not min/max blindly. `platformAudience` must be threaded end-to-end: the shared `MatchableProfile` (`matching.ts:32`), the API `toMatchable`/serialize (`apps/api/src/services/matching.ts:87,381`), and the web profile type (`apps/web/.../types.ts:124`) all currently omit it — explicit tasks add it to each. Legacy scoring path is unchanged when the fields are absent. Tests cover base=120k/seasonal=135k/promo=90k selection and per-platform ranking.

## Risks / Trade-offs

- **Extractor now emits subscriber counts it used to drop → risk of mislabeling reach as subscribers** → Mitigation: emit under a distinct field namespace (`audience.subscribers.<platform>`); keep the «не путай подписчиков с охватом» rule but route subscribers to the new field instead of dropping. Low confidence still allowed.
- **Registry v2 keys could collide with existing operator-approved proposals of the same name** → Mitigation: `indexRegistry` already prefers active entries; seed is idempotent on key; a pre-existing approved `prepayment` proposal simply matches the new active key.
- **`derivePlacementFormatKey` change could shift existing derived format keys** → Mitigation: only appends when tariff/slot present; existing offers without them are unchanged (covered by a regression test).
- **Migration ordering** → name `9b_…` so it sorts after `9a_guided_discovery_enriching` (Prisma applies lexical order; known footgun past `9_`).

## Migration Plan

`pnpm db:migrate` adds the `platform_audience` column (nullable-with-default, no backfill needed). Seed adds v2 registry rows (`status='active'`). Rollback = revert commit + drop column; existing `placementOffers`/`audience` are untouched. Profiles gain `platformAudience` on their next extraction (or via the re-run from change #3).

## Open Questions

- Whether `slot` is `string` or `number` — using `string` so «1»/«первый»/«A» all fit; matching treats it opaquely. (Leaning string.)
- Whether to fold `top_pin_hours` into a future first-class `duration` model — deferred; for now it's a numeric attribute.
