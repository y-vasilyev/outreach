## 1. Exchange rates

- [ ] 1.1 Prisma: `ExchangeRate` model (`exchange_rate`: currency PK, rateToRub Decimal, asOf, source, updatedById, updatedAt); part of migration `9g_price_normalization`; no seed rows
- [ ] 1.2 API: admin-only CRUD `GET/PUT /settings/exchange-rates` (zod schemas in `packages/shared/src/schemas/`); rate upsert enqueues `offer-renormalize`
- [ ] 1.3 Web: Settings → Exchange rates page (admin), empty-state prompting USD/EUR, shows rate age
- [ ] 1.4 API integration tests: role gating, upsert triggers renormalize job

## 2. Normalization core

- [ ] 2.1 Migration `9g_price_normalization` (continued): nullable `price_rub_min`, `price_rub_max`, `fx_rate_used`, `fx_as_of`, `cpm_rub`, `views_basis`, `views_source` on `placement_offer`; partial index `(cpm_rub) WHERE status='active'`
- [ ] 2.2 `packages/shared/src/offer-normalization.ts`: pure `normalizeOffer()` — fx math (RUB ⇒ rate 1), open ranges, CPM formula, kind gating (package/other ⇒ null CPM); exhaustive unit tests
- [ ] 2.3 Views basis resolver: median views of newest ≤20 fresh platform post insights → `avgViews` fallback → null; unit tests incl. outlier/median behavior
- [ ] 2.4 Worker `profile-extract`: call `normalizeOffer()` before row insert (missing rate ⇒ null columns + log, row still written)

## 3. Price ranges

- [ ] 3.1 `schemas/placement-offer.ts`: optional `price_min`/`price_max` on draft + row schemas; refinement `price === price_min` when both present
- [ ] 3.2 `blogger-profile-enrichment.ts`: deterministic range parsers «5-7к»/«5—7 тыс»/«от X»/«до X» with multiplier distribution; extend parser fixture suite
- [ ] 3.3 `RateCardExtractor`: prompt + output schema emit ranges; tolerant per-element validation unchanged; agent unit tests with mocked LLM
- [ ] 3.4 Row mapper writes `priceMin/priceMax` from ranges (single price ⇒ min=max); `rawPrice` keeps the literal token

## 4. Renormalize job

- [ ] 4.1 `apps/workers/src/queues/offer-renormalize.ts`: by-currency (rate upsert) and by-profile-CPM (post-insight refresh hook) modes; batch-update derived columns of `active` rows only
- [ ] 4.2 Wire post-insight refresh completion to enqueue CPM renormalize for the profile
- [ ] 4.3 One-shot enqueue script for initial renormalize of existing rows (`pnpm db:renormalize:offers`)
- [ ] 4.4 Integration tests: rate change touches only that currency's active rows; superseded rows untouched; derived-only column writes

## 5. Matching & read path

- [ ] 5.1 `matching.ts`: prefilter + `budgetScore` use `priceRubMin` with raw-`price` fallback; `fitSignals` += `{cpmRub, currency, fxAsOf}`; rationale mentions CPM
- [ ] 5.2 All-RUB no-range regression fixture: matching output byte-identical pre/post change
- [ ] 5.3 Blogger-profile read + catalog payloads expose normalized values alongside raw (₽-price, CPM, «по курсу от <даты>», «≈» marker for profile-avg CPM)
- [ ] 5.4 Web: profile card / catalog row render normalized price + CPM with basis hint

## 6. Planner duration follow-up (already implemented — pin it)

- [ ] 6.1 Regression test: with `structured_placement_offers` on, a priced post offer without `duration` ⇒ planner asks the focused duration question (registry `requiredForKinds: ['post']` + `buildPlannerPlacementInputs` path); no code change
- [ ] 6.2 Docs note (`AGENTS.md`/rollout): the prod activation lever for the follow-up is the `structured_placement_offers` flag

## 7. Docs & rollout

- [ ] 7.1 `DESIGN.md` (normalization layer, exchange rates, CPM) + `AGENTS.md` (RateCardExtractor range contract, planner duration follow-up) + `CHANGELOG.md`
- [ ] 7.2 Rollout: migrate → deploy → one-shot renormalize → verify (regression fixture, USD end-to-end, CPM sanity); rollback = revert deploy, columns inert
- [ ] 7.3 `pnpm typecheck && pnpm lint && pnpm test` green
