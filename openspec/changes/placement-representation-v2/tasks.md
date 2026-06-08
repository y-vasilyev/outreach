## 1. DB migration + schema (packages/db)

- [ ] 1.1 Add `platformAudience Json @default("[]") @map("platform_audience")` to `BloggerProfile` in `schema.prisma`.
- [ ] 1.2 Create migration `9b_placement_representation_v2` (named to sort after `9a_*`) adding the `platform_audience` column with default `'[]'`.
- [ ] 1.3 `pnpm db:migrate` locally; confirm the migration applies cleanly and is the last in lexical order.

## 2. Registry v2 + offer schema (packages/shared)

- [ ] 2.1 Add the eight v2 entries to `PLACEMENT_ATTRIBUTE_REGISTRY_V1` (tariff_name[string], slot[string], price_period[enum base|seasonal|promo], prepayment[string], tax_regime[enum ip|self_employed|ooo|none], tax_included[boolean], top_pin_hours[number], package_items[string_list]) with descriptions + applicableKinds. **All `requiredForKinds: []`** (no new planner follow-ups). No separate `package_price` — package total stays on `kind=package` + `offer.price`.
- [ ] 2.2 Add `tariff_name`/`slot` to the OFFER dedupe keys — `offerDedupeKey` (`profile-rollup.ts:161`) and the extractor's `pushOffer`/`PLACEMENT_DEDUPE` — so same-price distinct slots stay distinct. DO NOT change `derivePlacementFormatKey` (keeps format strings + legacy-card suppression byte-identical).
- [ ] 2.3 Add a `PlatformAudienceEntryZ` schema + `BloggerProfile.platformAudience` field in `schemas/blogger-profile.ts`.
- [ ] 2.4 Unit tests: registry v2 keys validate as active (not proposals); two same-price slots stay distinct after roll-up; an offer with no slot/tariff yields the SAME `derivePlacementFormatKey` as before (regression); a planner regression asserting v2 registry adds NO new `missingRequiredAttributes`.

## 3. Roll-up: per-platform audience (packages/shared/profile-rollup.ts)

- [ ] 3.1 Compose `platformAudience` from `audience.subscribers.<platform>` data points (latest-high-confidence per platform); add to `RolledUpProfileFields`.
- [ ] 3.2 Persist `platformAudience` in the profile-extract roll-up write (`apps/workers/src/queues/profile-extract.ts`).
- [ ] 3.3 Unit test: four `audience.subscribers.*` points → four `platformAudience` entries; reach scalar unaffected.

## 4. Deterministic + LLM extraction (packages/shared + packages/agents)

- [ ] 4.1 `AudienceStatsExtractor`: emit `audience.subscribers.<platform>` for per-platform subscriber counts (stop dropping them); update `FALLBACK_SYSTEM` prompt accordingly.
- [ ] 4.2 Deterministic capture in `blogger-profile-enrichment.ts`: `price_period=seasonal` from «цена <месяц>/акция», `tax_regime`/`tax_included` from «ИП»/«включ», `top_pin_hours` from «\d+ ?ч» tiers, `prepayment` from «\d+% предоплат», clear «слот N» → `slot`, «Пакетное <price> оба формата» → a `kind=package` offer with `price`=package total + `package_items` listing the formats.
- [ ] 4.3 `RateCardExtractor` prompt: mention tariff_name/slot/price_period/prepayment/package as recognized attributes.
- [ ] 4.4 Unit tests for each deterministic v2 capture using the real reply fragments.

## 5. Matching + read API (packages/shared + apps/api + web types)

- [ ] 5.1 Thread `platformAudience` through the matchable path: add it to the shared `MatchableProfile` (`matching.ts:32`), the API `toMatchable`/serialize (`apps/api/src/services/matching.ts:87,381`), and the web profile type (`apps/web/src/features/agency/types.ts:124`).
- [ ] 5.2 `matching.ts`: use a target platform's `platformAudience` subscriber count for platform-targeted ranking; for budget fit pick the `base` `price_period` variant (fallback seasonal/promo) instead of blind `Math.min`; keep legacy path + the `structured_placement_offers` gate (default off) unchanged.
- [ ] 5.3 `apps/api/src/services/blogger-profiles.ts`: include `platformAudience` + v2 attributes in the profile read; allow catalog list to sort/filter on a platform's subscribers.
- [ ] 5.4 Tests: base=120k/seasonal=135k/promo=90k → budgets on 120k; per-platform audience ranks platform-targeted briefs; read API returns platformAudience; everything legacy-identical when v2 fields absent.

## 6. Seed + acceptance

- [ ] 6.1 Seed the v2 registry rows (`status='active'`) in `packages/db/prisma/seed.ts`.
- [ ] 6.2 Extend the acceptance fixtures: Натали per-platform audience → 4 `platformAudience` entries; tomnayaa base/June → two offers with `price_period`; Scandi same-tariff slots → distinct offers; doctor «Пакетное 50 тыс оба формата» → a `kind=package` offer (price 50000) with `package_items`.

## 7. Verification

- [ ] 7.1 Run `pnpm db:migrate` (generates Prisma client for the new column), confirm migration is last in lexical order; `pnpm typecheck && pnpm lint && pnpm test` green.
- [ ] 7.2 Update `CHANGELOG.md` (operator-visible: per-platform audience + tariff/slot/season/prepayment/tax now captured & comparable).
- [ ] 7.3 `openspec validate placement-representation-v2 --strict` passes.
