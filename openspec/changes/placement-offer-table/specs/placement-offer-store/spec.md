## ADDED Requirements

### Requirement: Placement offers persist as first-class rows

The system SHALL persist every extracted placement offer as a row in a `placement_offer` table with typed columns for `profileId`, `platform`, `kind`, `priceMin`, `priceMax`, `currency`, `duration`, `tariffName`, `slot`, `status`, `confidence`, `capturedAt`, and SHALL keep all remaining offer attributes verbatim in an `attributes Json` column — including values whose registry keys are not (yet) active. Single-price offers SHALL store `priceMin = priceMax`; term-only offers SHALL store both as null.

#### Scenario: Offer with v2 attributes lands with columns + JSON split

- **WHEN** extraction yields a Telegram post offer «47 000 ₽, тариф «Базовый», предоплата 100%»
- **THEN** the row stores platform/kind/priceMin=priceMax=47000/currency/tariffName in columns and `prepayment` inside `attributes`, dropping nothing

#### Scenario: Term-only offer is persisted

- **WHEN** extraction yields an offer with conditions but no usable price
- **THEN** a row is written with null `priceMin`/`priceMax` and the conditions preserved in columns/`attributes`

### Requirement: Every offer row preserves raw source data and provenance

Each `placement_offer` row SHALL carry `rawPrice` (the literal price text as written, e.g. «от 118 000»), `rawSnippet` (verbatim source fragment), `sourceDataPointId` (plain reference to the originating `profile_data_point`, which links to `source_message_id`), `extractedBy`, `confidence`, and `capturedAt`. Normalization SHALL never overwrite or discard the raw values.

#### Scenario: Lossy price coercion is reversible

- **WHEN** «от 118 000» is coerced to `priceMin = 118000`
- **THEN** the row's `rawPrice` still reads «от 118 000» and `rawSnippet` contains the surrounding source text

### Requirement: Offer lifecycle is append-only with supersede chains

Offer rows SHALL carry `status ∈ {active, superseded, low_confidence}` and `supersededById`. No code path SHALL physically delete offer rows. The identity key (platform, kind, duration, tariffName, slot — exactly the current dedupe participants minus price, currency and rawSnippet) SHALL be computed by the shared helper, persisted as an `identityKey` column, and uniqueness of the `active` row per `(profileId, identityKey)` SHALL be enforced by a partial unique index. When a newly written offer matches an `active` row of the same profile on the identity key, the system SHALL resolve the pair deterministically: at a different price the newer row becomes `active` and the prior row gets `status='superseded'` + `supersededById`; at the same price/currency the existing confidence-band freshness rule picks the surviving `active` row. Offers below the placement-offer confidence floor SHALL be written with `status='low_confidence'`, never roll up, and never supersede anything. Operator re-run with supersede SHALL mark the affected rows `superseded` instead of deleting them.

#### Scenario: Price change creates history, not a duplicate

- **WHEN** a profile has an active Telegram month-post offer at 40 000 ₽ and a new reply quotes 47 000 ₽ for the same terms
- **THEN** the 47 000 row becomes `active`, the 40 000 row becomes `superseded` with `supersededById` pointing at the new row, and both remain queryable

#### Scenario: Operator re-run keeps the audit trail

- **WHEN** an operator re-runs extraction with supersede for a source message
- **THEN** offer rows originating from that message become `superseded` (not deleted) and fresh rows are written by the re-extraction

#### Scenario: Concurrent writers cannot create two active rows

- **WHEN** two transactions race to write offers with the same identity for one profile
- **THEN** the partial unique index rejects the loser, whose retry observes the winner and supersedes it normally

#### Scenario: Low-confidence offer is stored but inert

- **WHEN** extraction emits an offer with confidence 0.1
- **THEN** the row is written with `status='low_confidence'` and does not appear in the rolled-up `placementOffers` nor supersede any active row

### Requirement: Dual-write is transactional and idempotent

The profile-extract worker SHALL write `placement_offer` rows in the same database transaction as the existing `placement.offer` data points; failure of either write SHALL fail the whole transaction (the job retries; no partial state). Writes SHALL be idempotent on `(profileId, sourceDataPointId)` so re-delivered jobs and concurrent backfill do not create duplicate rows.

#### Scenario: Row write failure aborts the transaction

- **WHEN** inserting a `placement_offer` row fails mid-transaction
- **THEN** the corresponding data-point writes roll back too and the job is retried

#### Scenario: Re-delivered job is a no-op

- **WHEN** the same extraction job runs twice for one source message
- **THEN** the second run writes no additional offer rows

### Requirement: Shared offer identity helper

The offer identity key SHALL be computed by a single shared helper in `packages/shared` used by the worker write path, the roll-up, and the backfill script, so identity semantics cannot drift between writers.

#### Scenario: Worker and roll-up agree on identity

- **WHEN** the worker dedupes offers at write time and the roll-up dedupes at compose time
- **THEN** both call the same helper and produce the same grouping for the same input offers

### Requirement: Historical offers are backfilled with provenance intact

The system SHALL provide an idempotent backfill (`pnpm db:backfill:offers`) that converts existing `placement.offer` data points into `placement_offer` rows, replaying chronologically by `capturedAt` so supersede chains match what dual-write would have produced. Unparseable historical JSON SHALL be logged with row ids and skipped without modifying `profile_data_point`.

#### Scenario: Backfill reproduces supersede chains

- **WHEN** a profile has two historical offers for the same identity at different prices
- **THEN** after backfill the older row is `superseded` and the newer is `active`, mirroring the write-time rule

#### Scenario: Backfill is safe to re-run

- **WHEN** the backfill runs a second time after a partial first run
- **THEN** already-converted data points are skipped and no duplicate rows appear
