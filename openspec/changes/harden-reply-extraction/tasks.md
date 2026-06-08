## 1. Shared price normalizer + coercion (packages/shared)

- [x] 1.1 Extract the price-normalization logic from `parsePrice` (blogger-profile-enrichment.ts) into an exported `normalizePriceToken(raw): number | null` helper, adding `млн`/`млрд` multipliers and an `от ` prefix strip; keep `parsePrice` delegating to it.
- [x] 1.2 Extend `PRICE_WITH_CURRENCY_RE_SOURCE` to accept `млн`/`млрд` in the multiplier group so prose prices like `1.2 млн` are captured.
- [x] 1.3 Replace `PlacementOfferDraftZ.price` (`schemas/placement-offer.ts`) with a `z.preprocess` using `normalizePriceToken` that coerces strings (`"от 118000"`, `"118 000"`, `"1.2млн"`, `"50к"`) to a number, yielding `null` (term-only) when not coercible instead of rejecting.
- [x] 1.4 Unit-test the normalizer (млн/млрд, spaces, `от`, к/тыс, comma decimal, junk → null) and the coercing price schema.

## 2. Deterministic parser layout coverage (packages/shared/blogger-profile-enrichment.ts)

- [x] 2.1 Add МАХ/MAX→`max`, Дзен/Zen→`zen`, ТГК→`telegram` to `platformFromHeader` and `platformFromInlineText` (promoted `platform` string only; no enum change).
- [x] 2.2 Add a comma-pair inline parser that splits a line on commas and recognizes per-fragment `<format> <price>` pairs, emitting one offer per pair (covers `Фото-пост 120000, Видео-пост 170000`; `35 тыс (текст+фото), 40 тыс (текст+видео)`; `видеопост ВК/ТГ 267000, +ютуб/тикток 506000`). Wire it into `extractPlacementOffersFromText` and `extractRateCardDataPointsFromText`.
- [x] 2.3 Extend the inline duration regex to capture `час топа` / `\d+\s*ч` ladders as separate offers; for tiers that don't fit day/week/month/permanent, attach the verbatim tier as a `notes` attribute (no loss).
- [x] 2.4 Change `taxFromText` to return `string[]` (sentence/`.`-split, dedup) and update inline/table/labeled offer builders to push one `tax` attribute per entry.
- [x] 2.5 Unit tests for each parser fix (platforms, comma-pairs, ladders, multi-tax) using minimal line fixtures.
- [x] 2.6 Regression fixtures for CURRENT inline/table layouts that already parse (e.g. `пост на сутки 13000, пост на месяц 21000 + налог 6%`, em-dash table rows) — assert the comma-pair parser composes via `pushOffer` dedupe with no duplication and no loss of line-level tax/delete/includes terms.

## 3. Tolerant element-wise validation (packages/agents/_runtime.ts)

- [x] 3.1 Add a tolerant assembly path to `invokeJson` ordered strict→repair→tolerant: strict `safeParse` first; on failure run the existing single repair shot (decorators.ts:249-267); ONLY if the repaired response still fails, `safeParse` each element of each array, keep valid, drop invalid with a structured warning `{ event:'extract.element_dropped', conversationId, sourceMessageId, array, reason }`. Tolerant assembly must not pre-empt the repair branch.
- [x] 3.2 Point `RateCardExtractor` and `AudienceStatsExtractor` at the tolerant path and ensure `run()` RETURNS the assembled (element-clean) object so `AgentRunner`'s post-`run` re-validation against `outputSchema` sees only surviving elements (AgentRunner re-parses output).
- [x] 3.3 Unit test: payload with 3 offers + 1 invalid element ⇒ 2 valid persisted, 1 dropped+logged; invalid `attribute_proposals` element doesn't lose valid `data_points`; a fixable whole-shape error still goes through the repair branch (tolerant not triggered).

## 4. Multi-tax + canonical write path (RateCardExtractor + worker + accessors)

- [x] 4.1 In `RateCardExtractor`, normalize each surviving `rate.*` data-point string value through `normalizePriceToken` before the numeric field-guard (`RateCardExtractor.ts:132-136`) so `"50к"`/`"1.2млн"` legacy values are not dropped; ensure multiple `tax` attributes from the deterministic pass survive the merge/validate step (don't dedupe distinct taxes); update `FALLBACK_SYSTEM` prompt to say two taxes ⇒ two `tax` attributes.
- [x] 4.2 In `profile-extract.ts`, remove the `structuredOffersEnabled` guard around `placement.offer` persistence, `placement_attribute` proposals, and the `BloggerProfile.placementOffers` roll-up write — always run them.
- [x] 4.3 Repurpose `structured_placement_offers` to matching/planner preference only: confirm reads (`blogger-profiles.ts` `withPresentation`) already expose offers unconditionally (leave as-is); keep the flag at fit-scoring (`blogger-profiles.ts:485-497`, `matching.ts`) and planner inputs (`agent-run.ts:448`); MOVE the placement-attributes review route (`placement-attributes.ts:22`) off the flag so always-persisted proposals are curatable. Document the flag's final scope where it is read.
- [x] 4.4 Add `getOfferAttributes(offer, key): PlacementAttributeValue[]` in `placement-offers.ts` (repeatable accessor); update matching `placement_terms` (`matching.ts:365`) to join ALL `tax` values instead of the first via `getOfferAttribute`.

## 5. Confidence-floor roll-up (packages/shared/profile-rollup.ts)

- [x] 5.1 Add exported `PLACEMENT_OFFER_CONFIDENCE_FLOOR` (default 0.2); in `collectPlacementOffers` exclude sub-floor offers from `placementOffers`; in the legacy `rate.<format>` selection (`profile-rollup.ts:245-268`) require the chosen point's confidence ≥ floor so sub-floor facts cannot leak into derived `rateCards`/`formats`. Leave data-point rows untouched.
- [x] 5.2 Unit tests: offer at 0.1 excluded from `placementOffers` AND from derived `rateCards`/`formats`, but still present in input points; offer at 0.9 included. Add a test asserting profile-API output and HUD/`isContributingValue` still treat the raw 0.1 observation as present (raw-observation freshness is intentionally floor-independent).

## 6. Acceptance fixtures (the five real replies)

- [x] 6.1 Add a fixtures file with the five verbatim replies and, for each, assert the representable facts land in `placementOffers` (platforms, per-format prices, tiers in notes, multi-tax) and assert the explicitly-deferred facts (per-platform audience, package object, tariff/slot, base-vs-season, prepayment) are documented as out-of-scope (not silently expected).
- [x] 6.2 Run `pnpm --filter @nosquare/shared --filter @nosquare/agents test` + the workers profile-extract tests; update tests that asserted old flag-gated persistence to the canonical-write semantics.

## 7. Verification

- [x] 7.1 `pnpm typecheck && pnpm lint && pnpm test` green.
- [x] 7.2 Update `CHANGELOG.md` (operator-visible: catalog now captures more reply layouts; structured offers always recorded).
- [x] 7.3 `openspec validate harden-reply-extraction --strict` passes.
