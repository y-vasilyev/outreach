## 1. Schema & shared helpers

- [ ] 1.1 Prisma: add `PlacementOfferRow` model (`placement_offer` table) — typed columns (`profileId`, `platform`, `kind`, `priceMin`, `priceMax`, `currency`, `duration`, `tariffName`, `slot`, `identityKey`, `status`, `supersededById`, `confidence`, `capturedAt`), provenance (`rawPrice`, `rawSnippet`, `sourceDataPointId`, `extractedBy`), `attributes Json`; indexes `(profileId, status)`, `(platform, kind, priceMin)`, `(capturedAt)`; partial unique `(profileId, identityKey) WHERE status='active'`
- [ ] 1.2 Migration `9f_placement_offer_table` (table + indexes only, additive); verify lexical ordering after `9e_*`
- [ ] 1.3 `packages/shared/src/placement-offers.ts`: extract `offerIdentityKey()` (identity = platform, kind, duration, tariffName, slot — current dedupe participants minus price/currency/rawSnippet; NO delete_policy); `offerDedupeKey()` delegates to it + price/currency/rawSnippet; unit tests prove worker/roll-up grouping parity
- [ ] 1.4 `packages/shared`: zod schema `PlacementOfferRowZ` + mapper offer↔row (columns + attributes JSON split, `rawPrice` preserved); unit tests incl. term-only and unknown-attribute offers

## 2. Worker dual-write

- [ ] 2.1 `profile-extract.ts`: inside the existing `$transaction`, write `placement_offer` rows per persisted `placement.offer` data point; idempotent on `(profileId, sourceDataPointId)`
- [ ] 2.2 Supersede-by-identity at write time per design D4 (price change → supersede chain; same price → confidence-band rule; `confidence < 0.2` → `status='low_confidence'`, never supersedes)
- [ ] 2.3 Operator re-run `supersede=true`: mark affected offer rows `superseded` (no delete) before re-extraction writes fresh rows
- [ ] 2.4 Integration tests (real Postgres): dual-write atomicity (row failure rolls back data points), idempotent re-delivery, supersede chain on price change, low-confidence inertness, operator re-run keeps rows, concurrent same-identity race resolved by the partial unique index
- [ ] 2.5 Append D8 note to `openspec/changes/eav-write-path-dual-write/proposal.md`: `placement_offer` = derived projection; joins divergence checks in Phase 3; dual-write source switches to EAV in Phase 4

## 3. Roll-up & read path

- [ ] 3.1 `profile-rollup.ts`: `composeOffersFromRows(rows)` — filter `active`, map to `PlacementOffer` shape, same ordering/floor; legacy data-point path kept as fallback
- [ ] 3.2 Worker + `apps/api/src/services/blogger-profiles.ts` compose `placementOffers` from rows with fallback; log `rollup_source`
- [ ] 3.3 Fixture equality test: rows-path vs legacy-path output equal on the five real failing-reply fixtures
- [ ] 3.4 `GET /blogger-profiles/:id`: expose offer history (active row + superseded chain per identity); zod schema in `packages/shared/src/schemas/`; API integration test

## 4. Backfill

- [ ] 4.1 `packages/db/scripts/backfill-placement-offers.ts` + `pnpm db:backfill:offers`: chronological replay by `capturedAt`, reuses `offerIdentityKey()` + tolerant per-element parse; unparseable rows logged+skipped; idempotent on `(profileId, sourceDataPointId)`
- [ ] 4.2 Backfill tests: supersede chains match dual-write semantics; re-run is a no-op; partial-run resume safe
- [ ] 4.3 Verification snippet/runbook in change notes: row count vs distinct `placement.offer` data points, spot-check chains on a profile with a known price change

## 5. Docs & rollout

- [ ] 5.1 `DESIGN.md`: placement_offer table, lifecycle, compose-from-rows; `AGENTS.md` untouched check (no agent contract changes)
- [ ] 5.2 `CHANGELOG.md`: operator-visible — price history on profile card API
- [ ] 5.3 Rollout order documented: migrate → deploy dual-write → backfill → verify; rollback = revert deploy (fallback path), table inert
- [ ] 5.4 `pnpm typecheck && pnpm lint && pnpm test` green
