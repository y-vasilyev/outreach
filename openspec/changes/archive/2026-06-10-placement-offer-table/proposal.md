## Why

Structured placement offers are already the canonical extraction output (`harden-reply-extraction` D3), but they persist only as JSON blobs — `ProfileDataPoint` rows with `field='placement.offer'` and a rolled-up `BloggerProfile.placementOffers` cache. There is no row-level, indexable representation of "an offer", so catalog search and matching must load the whole catalog into memory and filter JSON; price history is invisible (roll-up keeps only the surviving offer per dedupe key); and operator re-run `supersede` physically deletes prior rows, destroying the audit trail. This change promotes the offer to a first-class `placement_offer` table — the foundation that `price-normalization-v2` (currency/period/CPM) and `catalog-sql-search` (SQL pushdown) build on.

## What Changes

- **New `placement_offer` table.** One row per extracted commercial offer with typed, indexable columns: `profileId`, `platform`, `kind`, `priceMin`/`priceMax` (single prices store min=max), `currency`, plus identity attributes that already participate in the roll-up dedupe key (`duration`, `tariffName`, `slot`) and a persisted `identityKey` with a partial unique index guaranteeing at most one `active` row per identity. Everything else stays verbatim in `attributes Json` — no attribute is dropped or coerced away.
- **Raw data never lost.** Each row carries `rawPrice` (the literal price text, e.g. «от 118 000»), `rawSnippet`, `attributes Json` (all active + as-yet-unrecognized values as emitted), `confidence`, `sourceDataPointId` → the originating `ProfileDataPoint` (which keeps `sourceMessageId`), `extractedBy`, `capturedAt`.
- **Lifecycle without deletes.** `status ∈ {active, superseded, low_confidence}` + `supersededById`. A newer offer with the same identity key supersedes the prior active row (price history for free). Operator re-run with `supersede=true` marks this table's rows superseded instead of deleting them. (Legacy `ProfileDataPoint` delete-on-supersede behavior is unchanged here; it is addressed by `extraction-provenance`.)
- **Dual-write from the worker.** `profile-extract` keeps writing `placement.offer` data points exactly as today AND writes/supersedes `placement_offer` rows in the same transaction. Existing idempotency semantics carry over.
- **Roll-up reads from the table.** `BloggerProfile.placementOffers` (the cache the catalog/matching read today) is composed from `active` rows, byte-compatible with the current rolled shape so no read-path consumer changes.
- **Backfill migration.** Existing `field='placement.offer'` data points are backfilled into the table with provenance intact; roll-up dedupe rules decide which backfilled rows start as `active` vs `superseded`.

## Capabilities

### New Capabilities

- `placement-offer-store`: row-level persistence of placement offers — schema, identity/dedupe semantics, lifecycle (supersede, never delete), provenance chain, backfill, and dual-write guarantees.

### Modified Capabilities

- `blogger-commercial-profile`: `BloggerProfile.placementOffers` becomes a cache derived from `active` `placement_offer` rows (same shape, same confidence floor); the profile read API additionally exposes offer row ids and superseded history per offer identity.

## Impact

- **DB migration `9f_placement_offer_table`** (named to sort after `9e_*` — Prisma lexical ordering): create `placement_offer` + indexes (`(profileId, status)`, `(platform, kind, priceMin)`, `capturedAt`) + data backfill from `profile_data_point`.
- **packages/db**: schema + migration; no seed changes.
- **packages/shared**: `profile-rollup.ts` gains a pure `composeOffersFromRows()` path (same dedupe/confidence rules, new input shape); offer identity key extracted as a shared helper so worker and roll-up cannot drift.
- **apps/workers**: `profile-extract.ts` dual-writes offer rows + supersede-by-identity in the existing transaction; operator re-run supersedes instead of deleting (this table only).
- **apps/api**: `blogger-profiles` read service composes from the table (output shape unchanged); `GET /blogger-profiles/:id` adds offer history.
- **apps/web**: no required changes (profile card may later render history; out of scope).
- **Compatibility**: `placementOffers` JSON shape, `rateCards` derivation, matching, and HUD are unchanged. `ProfileDataPoint` writes are unchanged. Dual-write is transactional — a failed row write fails the whole job (BullMQ retries), never partial state.
