## Context

Structured placement offers are the canonical extraction output (`profile-extract.ts` writes them unconditionally as `ProfileDataPoint` rows with `field='placement.offer'`, JSON value = `PlacementOffer`), and `BloggerProfile.placementOffers` is the rolled-up cache the catalog/matching read. Three structural problems follow from "offer = JSON blob":

1. **Not indexable.** Catalog/matching load every profile and filter `placementOffers` JSON in memory (`apps/api/src/services/matching.ts` stage-1 prefilter). SQL pushdown («ТГ-посты до 50 000 ₽, свежее 60 дней») is impossible.
2. **No price history.** Roll-up keeps one surviving offer per dedupe key; the prior price is only recoverable by re-reading all data points.
3. **Supersede deletes.** Operator re-run (`operator-reanalyze-and-markup`) deletes prior `(profileId, sourceMessageId)` data points — including offer rows — so the audit trail of "what we believed before" is destroyed.

Constraints: the rolled `placementOffers` shape is consumed by matching (`packages/shared/src/matching.ts`), the catalog UI, and the HUD — it must stay byte-compatible. Prisma migrations must sort lexically after `9e_*`. The dedupe identity already exists (`offerDedupeKey()` in `profile-rollup.ts`: platform, kind, duration, delete_policy, price, currency, rawSnippet, tariff_name, slot) and the worker has its own near-copy in `pushOffer` — a known drift hazard.

Downstream changes build on this table: `price-normalization-v2` adds RUB-normalized columns + CPM; `catalog-sql-search` adds the query API. This change deliberately ships the storage layer only.

## Goals / Non-Goals

**Goals:**

- One row per extracted offer in a `placement_offer` table with typed columns for the fields search will filter on, and `attributes Json` for everything else (verbatim, including not-yet-active registry keys).
- Full provenance per row: `rawPrice`, `rawSnippet`, `sourceDataPointId` → `ProfileDataPoint` → `sourceMessageId`, `extractedBy`, `confidence`, `capturedAt`.
- Append-only lifecycle: `active | superseded | low_confidence`, `supersededById`; no code path deletes rows.
- Backfill from existing `placement.offer` data points; roll-up composes `placementOffers` from `active` rows with unchanged output.
- Single shared identity-key helper used by worker write, roll-up, and backfill.

**Non-Goals:**

- No currency conversion, price ranges from the extractor, period canonicalization, or CPM (→ `price-normalization-v2`; the table just reserves `priceMin`/`priceMax`).
- No search/filter API or UI (→ `catalog-sql-search`).
- No change to `ProfileDataPoint` semantics, including its delete-on-supersede (→ `extraction-provenance`).
- No generic EAV (`entity_value`) — this is the domain table the EAV roadmap explicitly left as an extension point.
- No extractor/agent prompt changes.

## Decisions

### D1. Domain table, not EAV

A dedicated `placement_offer` table over the proposed-only generic `entity_value` store. The offer is THE domain entity operators search on; it has a stable, known column set; and the project decision of record is to build near-term on `placementOffers` extension points. EAV phases (metadata registry, blogger aggregate) remain compatible later — this table can become one projection of it.

### D2. Column vs JSON split = "what the dedupe key + search need"

Typed columns: `platform`, `kind`, `priceMin`, `priceMax`, `currency`, `duration`, `tariffName`, `slot`, `status`, `confidence`, `capturedAt`. These are exactly the identity-key participants plus price bounds — what `catalog-sql-search` will filter/sort on. Everything else (`delete_policy`, `prepayment`, `tax_*`, `top_pin_hours`, `package_items`, unknown proposals…) stays in `attributes Json` verbatim. Alternative — one column per registry attribute — rejected: the registry is open (proposed→active workflow), columns would chase it forever.

`priceMin = priceMax = price` for today's single-price offers; both nullable for term-only offers. `rawPrice` keeps the literal token («от 118 000») so the lossy "от → exact number" coercion is reversible.

### D3. Dual-write in the same transaction; data points stay canonical for facts

The worker keeps writing `placement.offer` data points exactly as today (HUD, freshness, re-derivation all read them), and additionally upserts `placement_offer` rows inside the same `$transaction`. If the row write fails, the transaction fails, BullMQ retries — never partial state. Alternative — replace the data-point write — rejected: it would change HUD/freshness inputs and violate "profile is re-derivable from data points".

Idempotency mirrors the existing one: skip when a row with the same `(profileId, sourceDataPointId)` already exists (one offer row per originating data point; re-delivered jobs are no-ops).

### D4. Supersede-by-identity at write time

When a new offer row arrives whose identity key matches an `active` row of the same profile (identity key = the existing `offerDedupeKey()` **minus** `price`, `currency` and `rawSnippet` — i.e. exactly platform, kind, duration, tariff_name, slot; note the current dedupe key does NOT include `delete_policy`, and the identity key follows it — delete_policy stays in `attributes`):

- same price/currency → keep the higher-confidence row `active` (CONFIDENCE_BAND freshness rule), mark the other `superseded`;
- different price → newer row becomes `active`, prior gets `status='superseded'`, `supersededById=<new row id>`. That chain IS the price history.

Rationale for dropping price from the identity key: with price included (as in roll-up dedupe today) a price change would create a second `active` row instead of a history chain. The roll-up's behavior is preserved anyway because only `active` rows roll up. `rawSnippet` is dropped for the same reason. Extending identity with `delete_policy` (arguably «с удалением»/«без удаления» are different products) is deliberately NOT done now — it would diverge from the established dedupe semantics and change backfill replay; it remains a future extension once extraction emits it reliably.

The computed identity is persisted as an `identityKey` column, and uniqueness of the active row is enforced by the database: partial unique index `(profile_id, identity_key) WHERE status = 'active'`. Supersede-by-identity runs inside the write transaction; a concurrent insert that would create a second active row fails on the index instead of corrupting the chain (the retry then sees the winner and supersedes normally).

Sub-floor offers (`confidence < PLACEMENT_OFFER_CONFIDENCE_FLOOR = 0.2`) are written with `status='low_confidence'`: persisted and auditable, never rolled up, never supersede anything.

Operator re-run with `supersede=true`: rows whose `sourceDataPointId` points to the superseded data points get `status='superseded'` (no delete), then re-extraction writes fresh rows. Note the referenced `ProfileDataPoint` rows are still deleted by the legacy path — `sourceDataPointId` is therefore a plain string reference (no FK), exactly like `sourceMessageId` today; `extraction-provenance` later makes those soft too.

### D5. Shared identity helper

Extract `offerIdentityKey()` (and keep `offerDedupeKey()` delegating to it + price/currency/rawSnippet) into `packages/shared/src/placement-offers.ts`. Worker `pushOffer`, roll-up, and the backfill script all import it. Removes the existing worker/roll-up near-duplicate.

### D6. Roll-up reads rows; output byte-compatible

`rollUpProfileFields()` gains `composeOffersFromRows(rows)` used by the worker and the profile read service: filter `status='active'`, map columns+attributes back to the `PlacementOffer` shape, apply the same ordering. The legacy compose-from-data-points path stays as fallback when the table has no rows for a profile (pre-backfill window, or dual-write disabled by incident override). A vitest fixture asserts old-path vs new-path equality on the five real failing-reply fixtures.

### D7. Backfill inside the migration, dedupe in code

Migration `9f_placement_offer_table` creates the table + indexes; backfill runs as a one-shot script (`packages/db/scripts/backfill-placement-offers.ts`, invoked via `pnpm db:backfill:offers`, idempotent) rather than raw SQL in the migration — it must reuse `offerIdentityKey()`/zod parsing from `packages/shared`, which SQL can't. Order: migrate → deploy workers (dual-write on) → run backfill (skips rows that already exist). Backfilled rows replay chronologically by `capturedAt` so supersede chains come out the same as if dual-write had always been on.

### D8. Relation to the EAV roadmap (authority and divergence rules)

The proposed-only EAV changes (`entity-types-shadow-metadata`, `eav-write-path-dual-write`, `blogger-aggregate-and-catalog`) plan dual-write of facts into `entity_value` with divergence logging, and Phase 4 makes EAV authoritative. `placement_offer` slots into that roadmap with explicit rules: (1) **authority** — facts (`ProfileDataPoint`, later `entity_value`) remain the source of truth; `placement_offer` is a derived domain projection optimized for search, rebuildable at any time via the backfill (same code path); (2) **divergence** — when Phase 3 lands, the shadow-rollup diff extends to offer rows (rows recomposed from EAV values vs existing rows), reusing the `rollup_divergence` mechanism; (3) **Phase 4** — the dual-write source switches from the legacy data-point write to the EAV write; the table, its lifecycle, and its consumers are unchanged. A corresponding note is added to the `eav-write-path-dual-write` proposal so neither document contradicts the other.

## Risks / Trade-offs

- [Worker and backfill write concurrently during rollout] → backfill idempotency key `(profileId, sourceDataPointId)` is the same as the worker's; chronological replay re-evaluates supersede-by-identity, so a race at worst leaves one extra `superseded` row, never a duplicate `active`.
- [Identity key drops price → two genuinely different same-format offers (e.g. два разных тарифа без `tariff_name`, или «с удалением»/«без удаления» without distinguishing attributes) collapse into one history chain] → only when extraction produced no distinguishing attribute at all; the superseded row remains visible, and operator markup (`operator-reanalyze-and-markup`) can re-extract with hints. Accepted.
- [Dual-write doubles offer-write volume] → offers are a few rows per inbound message; negligible against existing data-point writes.
- [Roll-up fallback path masks dual-write failures] → `rollup_source` debug log field + the existing raw-payload snapshot; `catalog-sql-search` later adds an ops counter for table-vs-fallback composes.
- [Backfill misparses historical JSON (schema drifted over time)] → backfill parses with the tolerant per-element zod parse from `harden-reply-extraction`; unparseable rows are logged with ids and skipped, never dropped silently from `profile_data_point` (which stays untouched).

## Migration Plan

1. `pnpm db:migrate` → `9f_placement_offer_table` (table + indexes only; additive, instant).
2. Deploy workers/api with dual-write + compose-from-rows-with-fallback.
3. `pnpm db:backfill:offers` (idempotent, chronological).
4. Verify: row counts vs distinct `placement.offer` data points; fixture equality check; spot-check supersede chains on profiles with known price changes.
5. Rollback: stop dual-write (revert deploy) — reads fall back to data-point compose automatically; table can be dropped or left inert. No data loss possible: `profile_data_point` is never modified by this change.

## Open Questions

- None blocking. Confidence-floor value and CONFIDENCE_BAND are reused as-is from `profile-rollup.ts`; if `price-normalization-v2` changes comparison semantics, supersede-by-identity is recomputed only for new writes (historical chains are not rewritten).
