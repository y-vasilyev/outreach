## Context

After `placement-offer-table`, offers are rows with `priceMin`/`priceMax`/`currency` and raw provenance. Comparison still breaks on three axes: cross-currency (matching's `budgetScore`/prefilter compare raw numbers to the brief budget — `packages/shared/src/matching.ts:196-216,560-577`), ranges (extractor emits a single coerced number; «от 118 000» becomes exactly 118000 with the «от» recoverable only from `rawPrice`), and cost-per-reach (no CPM anywhere, though `BloggerPostInsight.metrics` already holds per-post views and profiles carry `avgViews`).

Constraints: normalization must be deterministic and replayable (no LLM); raw columns are immutable once written (`placement-offer-store` requirement); matching's deterministic path must stay byte-stable for the all-RUB no-range catalog (regression guarantee); planner follow-ups are expensive (one extra question per dialogue max — the `placement-representation-v2` decision that v2 keys add no default follow-ups must not be silently reversed registry-wide).

## Goals / Non-Goals

**Goals:**

- Operator-maintained exchange rates with audit trail; every normalized value traceable to the rate version used.
- `priceRubMin/Max` + `cpmRub` as indexable columns on `placement_offer`, recomputed (never hand-edited) by a pure function.
- Ranges preserved end-to-end: extractor → row → read API.
- Budget fit in RUB; CPM visible in fit signals and on the profile.
- The existing duration follow-up (registry `requiredForKinds: ['post']` + planner) is regression-pinned so prices stay like-for-like comparable.

**Non-Goals:**

- No automatic rate fetching from external APIs (kill-switch-free external dependency; can be added later as a worker behind a flag).
- No historical fx revaluation: superseded rows keep the normalization they had; only `active` rows recompute on rate change.
- No CPM in the match score weights (informational only; re-weighting is a separate tuning exercise).
- No price-period (base/seasonal/promo) arithmetic — `price_period` stays a label.
- No search API/UI filters (→ `catalog-sql-search`).

## Decisions

### D1. Operator-maintained `exchange_rate`, point-in-time stamped per row

Table: `currency (PK)`, `rateToRub Decimal`, `asOf DateTime`, `source ('manual')`, `updatedById`, `updatedAt`. No seed rows: inventing a default rate would normalize silently with a made-up number; instead non-RUB offers stay unnormalized until the operator sets a rate (Settings empty-state prompts for USD/EUR). Each normalized offer stores `fxRateUsed` + `fxAsOf` — so a stored `priceRubMin` is always explainable («по курсу 92.4 от 2026-06-01») and stale rates are visible, not silent. Alternative — join to the rate table at read time — rejected: SQL pushdown in `catalog-sql-search` needs materialized columns, and rate edits would silently rewrite history.

Rationale for not auto-fetching: an external FX API is a new failure mode + dependency for a system where ±5% accuracy is fine for catalog comparison; operator updates monthly. The schema (`source` column) leaves room for an `auto` worker later.

### D2. `normalizeOffer()` is pure and idempotent; recompute is a queue job

`packages/shared/src/offer-normalization.ts`: `(offer row fields, rate, viewsBasis) → {priceRubMin, priceRubMax, fxRateUsed, fxAsOf, cpmRub, viewsBasis, viewsSource}`. RUB offers: `priceRub* = price*`, `fxRateUsed = 1`. Unknown currency (no rate row): normalized columns stay null, row logged — offer still rolls up, it just doesn't participate in RUB filters (fail-open for visibility, fail-closed for comparison).

`offer-renormalize` worker (new queue): triggered by (a) rate upsert — recompute all `active` rows in that currency; (b) post-insight refresh completion — recompute `cpmRub` for that profile's `active` rows. Batch updates only normalized columns. Superseded/low_confidence rows are never touched (history shows what we believed then).

### D3. Ranges: `priceMax = null` means open-ended «от»

Extractor (`PlacementOfferDraftZ` + deterministic parsers) emits `price_min`/`price_max`: «5–7к» → 5000/7000; «от 118 000» → 118000/null; exact «47к» → 47000/47000; no price → null/null (term-only, unchanged). Legacy `price` field stays = `price_min` so every existing consumer (dedupe keys, format derivation, matching legacy path) is untouched. Budget comparisons use `priceRubMin` — the optimistic bound; an «от»-offer over budget at its minimum is genuinely over budget, while one under budget at minimum is worth an operator look. Alternative — store «от» as min=max plus a boolean — rejected: null max composes naturally with range queries (`priceRubMin <= :budget`) and avoids a flag every consumer must remember.

Range parsing handles «5-7к», «5—7 тыс», «от X», «до X» (→ null/X) via `normalizePriceToken()` per side; multiplier distributes («5–7к» = 5к–7к, not 5–7000). These join the existing parser fixture suite.

### D4. CPM basis: platform post views, profile fallback

`cpmRub = priceRubMin / views × 1000`. Views resolution order: (1) median `views` of the newest ≤20 `BloggerPostInsight` rows for the offer's platform with fresh metrics; (2) `BloggerProfile.avgViews`; (3) none → `cpmRub = null`. `viewsSource ∈ {post_insights, profile_avg}` + `viewsBasis` (the number used) are stored so a CPM is always explainable. Median over mean: top-post outliers (the catalog stores top posts) would systematically understate CPM. Only `kind`-priced offers get CPM where views are the right denominator (post, story, reels, video, integration); `package`/`other` → null.

### D5. Matching: RUB budget, CPM as signal not score

`isShortlisted`/`budgetScore` switch from `price` to `priceRubMin` with fallback to raw `price` when normalized columns are null (unknown currency / pre-migration rows) — preserving today's behavior exactly for the all-RUB catalog (`fxRateUsed=1` ⇒ `priceRubMin === priceMin === price`). `fitSignals` gains `{cpmRub, fxAsOf, currency}` for cited offers; rationale mentions CPM when present. Score weights untouched — changing ranking quality is observable-first (operators see CPM in results), tunable later.

### D6. Duration follow-up already exists — pin it, don't rebuild it

Initial draft proposed campaign-config required attributes; review against the code showed the mechanism already exists end-to-end: the registry marks `duration` `requiredForKinds: ['post']` (`placement-offers.ts`), and `buildPlannerPlacementInputs` (`agent-run.ts`) feeds active required keys to the planner whenever `structured_placement_offers` is on — the planner then asks the focused duration question for priced offers. So this change adds only a regression test pinning that behavior (priced post offer without duration ⇒ duration follow-up) and a docs note that the prod activation lever is the feature flag. Campaign-level overrides of required attributes remain future work if a campaign ever needs opt-out. Currency is NOT chased: RU dialogues default RUB correctly, and a «в какой валюте?» turn is almost always wasted.

## Risks / Trade-offs

- [Operator forgets to update rates → stale normalization] → `fxAsOf` surfaces on profile/catalog («по курсу от 1 июня»); Settings shows rate age; no silent failure.
- [Rate change triggers mass recompute] → bounded: `active` rows in one currency; batched updates of 4 columns; queue isolation keeps it off the extraction path.
- [CPM misleads when views basis is weak (few posts, stale metrics)] → `viewsSource`/`viewsBasis` stored and surfaced; UI labels profile-avg-based CPM as approximate («≈»).
- [«от»-prices entering budget fit at min may shortlist optimistically] → intentional: false-include beats false-exclude for an operator-curated shortlist; rationale cites the open range.
- [Duration follow-up depends on the `structured_placement_offers` flag being on in prod] → documented as the activation lever; the regression test covers the flag-on path so enabling it cannot silently lose the behavior.
- [Drift between `price` and `price_min` in drafts] → zod refinement: if both present, `price === price_min`; mapper writes from one source of truth.

## Migration Plan

1. `9g_price_normalization`: `exchange_rate` + seed; nullable columns on `placement_offer`; partial index `(cpm_rub) WHERE status='active'`.
2. Deploy shared/agents/workers/api together (schema-additive; old workers ignore new columns).
3. One-shot renormalize of existing `active` rows (same `offer-renormalize` job, enqueued for all currencies + all profiles' CPM).
4. Verify: all-RUB regression fixture (matching output byte-identical); spot-check a USD offer end-to-end; CPM sanity on a profile with post insights.
5. Rollback: revert deploy; columns stay nullable and unread by the old code. No raw data touched at any point.

## Open Questions

- None blocking. (Seed-vs-empty for rates resolved as «seed empty + Settings empty-state prompt» — see D1.)
