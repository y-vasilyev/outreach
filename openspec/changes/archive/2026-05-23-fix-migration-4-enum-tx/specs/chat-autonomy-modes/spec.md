## MODIFIED Requirements

### Requirement: Renaming `auto` to `semi_auto`

The mode previously named `auto` SHALL be renamed to `semi_auto`. The new `auto` mode introduces stricter behavior with silent fallback and is not backward-compatible with the previous semantics.

The rename SHALL be delivered as **two physically separate database migrations** so that `prisma migrate deploy` succeeds on a fresh Postgres cluster. Postgres forbids using a value added via `ALTER TYPE ... ADD VALUE` in the same transaction in which the value is added; consequently the migration adding `semi_auto` to the `ConversationMode` enum MUST commit before any migration that issues `UPDATE` statements referencing `semi_auto`.

#### Scenario: Existing data is migrated

- **WHEN** the schema migrations run on a database with conversations or campaigns whose mode is the legacy `auto`
- **THEN** the enum-add migration commits the new `semi_auto` value first, and a subsequent backfill migration updates all such rows to `semi_auto` before the new `auto` semantics are introduced

#### Scenario: Fresh Postgres cluster accepts the migration set

- **WHEN** `prisma migrate deploy` is run against a Postgres database with no migration history
- **THEN** every migration applies cleanly with no `unsafe use of new value 'semi_auto' of enum type ConversationMode` error, and the database ends in a state where `ConversationMode` contains both `auto` and `semi_auto`

#### Scenario: Backfill migration is idempotent

- **WHEN** the `semi_auto` backfill migration is executed against a database that already has no `mode = 'auto'` (or `defaultMode = 'auto'`) rows
- **THEN** the migration succeeds as a no-op (zero rows updated) without raising any error

#### Scenario: API normalises legacy input during transition

- **WHEN** during the migration window an API client submits `mode = 'auto'` matching the legacy semantics
- **THEN** the system SHALL accept the value, normalise it to `semi_auto` on write, and respond successfully; once the rename is complete, `auto` shall mean the new strict mode and no normalisation occurs
