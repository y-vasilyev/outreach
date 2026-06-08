## Context

The inbound extraction pipeline (`handleProfileExtract` → `rate_card_extractor` + `audience_stats_extractor` → `ProfileDataPoint`/`placement.offer` rows → `rollUpProfileFields` → `BloggerProfile`) already has the right two-layer shape: per-fact EAV provenance rolled up into a queryable catalog row. The problem is operational losses on the happy path:

- `invokeJson` (`packages/agents/src/agents/_runtime.ts:78-83`) validates the entire extractor payload with one `outputSchema.parse()`; one bad element + one repair shot → total loss (`packages/llm/src/decorators.ts:235-285`).
- `PlacementOfferDraftZ.price` is `z.number()`, so `"от 118000"` rejects the payload (`packages/shared/src/schemas/placement-offer.ts:87`).
- Structured persistence + roll-up are gated behind `structured_placement_offers` (default off), so production runs the lossy legacy `rate.<format>` path (`apps/workers/src/queues/profile-extract.ts:194-200,266,362`).
- The deterministic parser (`packages/shared/src/blogger-profile-enrichment.ts`) only matches em-dash table rows + `пост на сутки/месяц`; `млн`, comma price-pairs, `час топа` ladders, МАХ/Дзен, and stacked taxes are missed.

## Goals / Non-Goals

**Goals:**
- No silent loss of facts that already have a representation. The five real failing replies land their representable facts losslessly.
- Structured placement offers are always persisted + rolled up (canonical write path); the flag becomes a read/match preference.
- Garbled low-confidence output stays reviewable but does not pollute the comparable catalog view.
- Zero DB migration; no API response-shape change.

**Non-Goals:**
- New representational fields (per-platform audience, package/tariff/slot/price_period/prepayment/tax-regime, duration enum extension) → `placement-representation-v2`.
- Reading attachment bytes / OCR → `attachment-ocr-ingestion`.
- Operator re-run, correction write-path, markup → `operator-reanalyze-and-markup`.
- Profile UI, post images, search/compare → `blogger-profile-who-is-this`.

## Decisions

### D1 — Tolerant validation at the element boundary, AFTER strict+repair
Order matters (codex): tolerant assembly must NOT pre-empt the repair loop in `decorators.ts:249-267`, which only fires on `LLM_SCHEMA_FAILED`. So the sequence is: (1) strict `outputSchema.safeParse`; (2) on failure, run the existing single repair shot; (3) only if the repaired response *still* fails strict parse, fall back to per-element `safeParse` assembly (keep valid elements, drop invalid with a structured warning). This way a genuinely fixable whole-shape error still gets the model's repair pass, and tolerant assembly is the last-resort net that prevents total loss. Implement as a tolerant branch in `invokeJson` keyed off an object-of-arrays output schema.
- **Alternative considered**: make every field in `ProfileExtractionOutputZ` lenient via `.catch()`. Rejected — `.catch()` silently swallows *and replaces with a default*, which hides drops and can fabricate empty offers; we want explicit drop-with-log.
- **Note (codex)**: `AgentRunner` re-validates the agent's returned output against `outputSchema` after `run()`. The tolerant assembly therefore must produce a value that passes the (now element-clean) schema, and `RateCardExtractor.run` must return that assembled object — not the raw LLM payload — so the runner's re-validation sees only surviving elements.

### D2 — Price coercion in the zod schema AND the legacy data-point path
Replace `PlacementOfferDraftZ.price: z.number()` with a `z.preprocess` that runs a shared `normalizePriceToken` (spaces, `к/тыс/млн/млрд`, `от` prefix, comma decimal) → number or `null`. Extract the normalizer out of `parsePrice` so the deterministic parser and the schema share one source of truth.
- **Gap codex flagged**: legacy `data_points[].value` is `z.unknown()` (`ProfileDataPointDraftZ.value`), and `RateCardExtractor`'s field guard only accepts `Number(v.replace(/[\s,]/g,''))` (`RateCardExtractor.ts:132-136`), so `"50к"`/`"1.2млн"` legacy values are silently dropped even after offer coercion. Fix: in the RateCardExtractor post-pass, normalize each surviving `rate.*` data-point value through `normalizePriceToken` (string → number) before the numeric guard, so the legacy compatibility stream coerces identically. We do NOT change `ProfileDataPointDraftZ.value`'s type (it is intentionally polymorphic across non-rate fields).

### D3 — Canonical write path by un-gating persistence; flag = matching/planner preference
Remove the `structuredOffersEnabled` guard around persistence and roll-up in `profile-extract.ts:194-200,266,362`; always write `placement.offer` rows + `placement_attribute` proposals and always set `BloggerProfile.placementOffers`.
- **Reality check (codex)**: the profile READ path (`blogger-profiles.ts` `withPresentation()`, ~:253-272) ALREADY exposes `placementOffers` and merges structured-derived `rateCards` unconditionally — there is no flag-gated "legacy read view". So the flag never governed reads; it governs **fit-scoring** (`blogger-profiles.ts:485-497`, `matching.ts`) and the **data-collection planner** structured-offer inputs (`agent-run.ts:448`). Repurpose the flag to mean exactly that: matching + planner prefer structured offers. Reads are always structured (unchanged). This makes flipping the flag a safe pure-preference change because persistence/reads are already complete.
- **Attribute-review routes (codex)**: `placement-attributes.ts:22` (admin proposal review) is also flag-gated today. Since proposals are now always persisted, leaving the review route gated would hide them. Decision: move the attribute-review route off `structured_placement_offers` so operators can curate the vocabulary that extraction now always produces (no web client yet — that surface arrives in `operator-reanalyze-and-markup`). Document the flag's final scope = matching + planner only.

### D4 — Confidence floor lives in the roll-up, applied to ALL comparable commercial views
`rollUpProfileFields` collects offers (`collectPlacementOffers`) AND legacy rate cards (`byConfidenceThenRecency` over `rate.<format>` points, `profile-rollup.ts:245-268`). Add a floor (default 0.2, exported `PLACEMENT_OFFER_CONFIDENCE_FLOOR`) applied in BOTH places:
- `collectPlacementOffers` excludes sub-floor offers from `placementOffers`;
- the legacy `rate.<format>` selection requires the chosen point's confidence ≥ floor, so a sub-floor structured offer cannot reappear via the derived `rateCards`/`formats` path (codex Blocker 2).
Data-point rows are never deleted; the floor is a comparable-view presentation rule only.
- **HUD/staleness is intentionally floor-independent (codex)**: `isContributingValue`/`collectedAgencyTargets` (`profile-staleness.ts:182-190`, `agent-run.ts:413`) report *raw observation* freshness and do not see confidence. This is consistent with the existing `blogger-commercial-profile` spec ("the signal is observation freshness, NOT the age of the displayed value"). We deliberately do NOT push the floor into HUD: a low-confidence observation still counts as "we have an observation, it just needs review". Documented as a non-goal here; surfacing "needs review" in the HUD is part of `operator-reanalyze-and-markup`.

### D6 — Repeatable attributes need a multi-value accessor
`getOfferAttribute` returns only the FIRST matching attribute (`placement-offers.ts:223`), and matching's `placement_terms` reads tax through it (`matching.ts:365`). With multiple `tax` attributes now possible, add `getOfferAttributes(offer, key): PlacementAttributeValue[]` and update the matching summary to join all `tax` values. `getOfferAttribute` stays for single-valued keys (duration, delete_policy). Rationale: minimal, backward-compatible; only repeatable keys use the new accessor.

### D5 — Parser fixes are additive and regex-local
`млн`/`млрд` → extend the multiplier group in `parsePrice` + `PRICE_WITH_CURRENCY_RE_SOURCE`. Platforms → extend `platformFromHeader`/`platformFromInlineText` maps with МАХ/MAX→`max`, Дзен/Zen→`zen`, ТГК→`telegram`. Comma price-pairs → a new `extractCommaPairOffersFromLine` that splits a line on commas and runs each fragment through the existing label+price recognizers, then is merged through the existing `pushOffer` dedupe so it composes with (does not double-count) the current inline/table builders, and preserves line-level tax/delete/includes the existing inline builder already applies. Ladders → extend the inline duration regex with `час топа`/`\d+\s*ч`, emitting `notes` for non-enum tiers. Stacked taxes → `taxFromText` returns `string[]` (sentence-split, deduped) and callers push one `tax` attribute per entry.
- **Regression guard (codex)**: comma-splitting can collide with the existing inline parser (e.g. `пост на сутки 13000, пост на месяц 21000 + налог 6%` already parses correctly today). Add regression fixtures for the current inline/table cases alongside the new comma-pair layouts, asserting no duplication and no loss of line-level terms. Each fix is contained and independently tested.

## Risks / Trade-offs

- **Tolerant parse hides a systematically broken extractor** → Mitigation: every dropped element logs a structured warning with `reason`; add a counter so a spike is observable. The repair loop still runs first for whole-shape errors.
- **Un-gating structured persistence increases write volume / changes existing rows** → Mitigation: persistence is idempotent on `(profileId, sourceMessageId, field, extractedBy[, rawSnippet])`; roll-up is deterministic. The only behavior change is that offers now also appear with the flag off. Update the tests that asserted the old flag-gated behavior.
- **Confidence floor could hide a genuine offer the model under-scored** → Mitigation: floor is low (0.2) and configurable; sub-floor offers remain in `dataPoints` and will be surfaced by the later needs-review/markup change. Document the floor constant.
- **Coercion could turn a non-price token into a wrong number** → Mitigation: the normalizer only matches the existing strict numeric+unit grammar; anything else yields `null` (term-only offer), never a fabricated number.

## Migration Plan

No DB migration. Deploy is code-only. Rollback is reverting the commit; persisted `placement.offer` rows written while deployed remain valid (they are just additional provenance rows). After deploy, existing profiles gain structured offers on their next inbound (or via the re-run added in change #3); no backfill is required for this change.

## Open Questions

- Exact default confidence floor (0.2 proposed) — tune from real data once observability is in; left configurable.
- Whether to expose the per-element drop counter as a metric now or defer to the observability work in change #3 (leaning defer; log-only here).
