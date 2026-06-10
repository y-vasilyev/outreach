## 1. Exchange rates

- [x] 1.1 Prisma: `ExchangeRate` model (`exchange_rate`: currency PK, rateToRub Decimal, asOf, source, updatedById, updatedAt); part of migration `9g_price_normalization`; no seed rows
- [x] 1.2 API: admin-only CRUD `GET/PUT /settings/exchange-rates` (zod schemas in `packages/shared/src/schemas/`); rate upsert enqueues `offer-renormalize`
- [x] 1.3 Web: Settings → Exchange rates page (admin), empty-state prompting USD/EUR, shows rate age
- [x] 1.4 API route tests (mocked prisma/queues): role gating, currency normalization/validation, upsert+delete trigger renormalize

## 2. Normalization core

- [x] 2.1 Migration `9g_price_normalization` (continued): nullable `price_rub_min`, `price_rub_max`, `fx_rate_used`, `fx_as_of`, `cpm_rub`, `views_basis`, `views_source` on `placement_offer`; partial index `(cpm_rub) WHERE status='active'`
- [x] 2.2 `packages/shared/src/offer-normalization.ts`: pure `normalizeOffer()` — fx math (RUB ⇒ rate 1), open ranges, CPM formula, kind gating (package/other ⇒ null CPM); exhaustive unit tests
- [x] 2.3 Views basis resolver: median views of newest ≤20 fresh platform post insights → `avgViews` fallback → null; unit tests incl. outlier/median behavior
- [x] 2.4 Worker `profile-extract`: call `normalizeOffer()` before row insert (missing rate ⇒ null columns + log, row still written)

## 3. Price ranges

- [x] 3.1 `schemas/placement-offer.ts`: optional `price_min`/`price_max` on draft + row schemas; refinement `price === price_min` when both present
- [x] 3.2 `blogger-profile-enrichment.ts`: deterministic range parsers «5-7к»/«5—7 тыс»/«от X»/«до X» with multiplier distribution; extend parser fixture suite
- [x] 3.3 `RateCardExtractor`: prompt + output schema emit ranges; tolerant per-element validation unchanged; agent unit tests with mocked LLM
- [x] 3.4 Row mapper writes `priceMin/priceMax` from ranges (single price ⇒ min=max); `rawPrice` keeps the literal token

## 4. Renormalize job

- [x] 4.1 `apps/workers/src/queues/offer-renormalize.ts`: by-currency (rate upsert) and by-profile-CPM (post-insight refresh hook) modes; batch-update derived columns of `active` rows only
- [x] 4.2 Wire post-insight refresh completion to enqueue CPM renormalize for the profile
- [x] 4.3 One-shot enqueue script for initial renormalize of existing rows (`pnpm db:renormalize:offers`)
- [x] 4.4 Worker tests (mocked prisma): rate change scopes to the currency's active rows; deleted rate ⇒ null normalization; derived-only column writes; profile-mode CPM

## 5. Matching & read path

- [x] 5.1 `matching.ts`: prefilter + `budgetScore` use `priceRubMin` with raw-`price` fallback; `fitSignals` += `{cpmRub, currency, fxAsOf}`; rationale mentions CPM
- [x] 5.2 All-RUB regression: existing matching suite passes untouched (no normalized fields ⇒ raw-price path identical); explicit unnormalized-fallback test added
- [x] 5.3 Blogger-profile read + catalog payloads expose normalized values alongside raw (₽-price, CPM, «по курсу от <даты>», «≈» marker for profile-avg CPM)
- [x] 5.4 Web: profile card / catalog row render normalized price + CPM with basis hint

## 6. Planner duration follow-up (already implemented — pin it)

- [x] 6.1 Regression already pinned by DataCollectionPlannerOffers.test.ts (priced post without duration ⇒ focused `duration`/`delete_policy` follow-up); no code change
- [x] 6.2 Docs note (`AGENTS.md`/rollout): the prod activation lever for the follow-up is the `structured_placement_offers` flag

## 7. Docs & rollout

- [x] 7.1 `DESIGN.md` (normalization layer, exchange rates, CPM) + `AGENTS.md` (RateCardExtractor range contract, planner duration follow-up) + `CHANGELOG.md`
- [x] 7.2 Rollout: migrate → deploy → one-shot renormalize → verify (regression fixture, USD end-to-end, CPM sanity); rollback = revert deploy, columns inert
- [x] 7.3 `pnpm typecheck && pnpm lint && pnpm test` green
