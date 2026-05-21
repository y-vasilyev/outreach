## ADDED Requirements

### Requirement: DB-backed feature flag store

The system SHALL store operational feature flags in a `feature_flag` table (one row per flag: `key`, `enabled`, `description`, audit fields) as the runtime source of truth. The set of valid flag keys SHALL come from a code registry; an unknown key SHALL resolve to disabled. The migration/seed SHALL insert the known flags with `enabled = false`.

#### Scenario: Known flags are seeded disabled
- **WHEN** the migration and seed run on a fresh database
- **THEN** the `feature_flag` table contains a row for each registry key with `enabled = false`

#### Scenario: Unknown key resolves to off
- **WHEN** code or the API requests a flag key not present in the registry/table
- **THEN** the accessor returns `false` and does not throw

### Requirement: Synchronous cached accessor with cross-process invalidation

The system SHALL expose a `FeatureFlags` accessor whose `get(key)` is synchronous (safe to call on the inbound hot path). The accessor SHALL load the table into an in-memory cache at process start and SHALL refresh that cache when a flag changes, propagating changes across the separate API and worker processes via a Redis pub/sub channel — so a toggle takes effect without restarting either process.

#### Scenario: get() is served from cache without a query
- **WHEN** `get(key)` is called repeatedly on the message-processing path
- **THEN** it returns the cached value synchronously and issues no per-call database query

#### Scenario: A toggle propagates to other processes
- **WHEN** the flag is changed via the API in the API process
- **THEN** the change is published to the invalidation channel and the worker process's cache reflects the new value without a restart

#### Scenario: Reload on (re)subscribe closes the missed-message window
- **WHEN** a process subscribes or re-subscribes to the invalidation channel
- **THEN** it reloads the flag cache from the database so it cannot stay stale across a reconnect

### Requirement: Environment override is a hard floor

The system SHALL honor an environment override `FEATURE_<KEY>_FORCE` (`on`/`off`) that takes precedence over the stored value. Resolution order SHALL be: env force, then the cached DB value, then the registry default (off).

#### Scenario: Env force-off wins over an enabled DB row
- **WHEN** `FEATURE_AGENCY_SOURCING_FORCE=off` is set and the `agency_sourcing` row is `enabled = true`
- **THEN** `get('agency_sourcing')` returns `false`

#### Scenario: Env force is logged at startup
- **WHEN** a process starts with any `FEATURE_<KEY>_FORCE` set
- **THEN** it logs which flags are pinned by the override

### Requirement: Fail-safe defaults

When the flag store cannot be read at startup, the accessor SHALL fall back to the registry defaults (off) and the process SHALL still start, logging a warning. The system SHALL NOT auto-enable any feature as a result of a store failure.

#### Scenario: Store unreachable at boot
- **WHEN** the database is unreachable during accessor `init()`
- **THEN** every flag resolves to its registry default (off), a warning is logged, and the process starts

### Requirement: Feature-gated routes resolve at request time

Routes for flag-gated capabilities SHALL be registered unconditionally and gated by a `requireFeature(key)` check evaluated per request (composed before role checks). When the flag is off the route SHALL respond 404 (feature disabled); when on it SHALL behave normally. Toggling the flag SHALL change route availability without a restart.

#### Scenario: Gated route is 404 when the flag is off
- **WHEN** a request hits a `requireFeature('campaign_types')`-gated route while the flag is off
- **THEN** the API responds 404 and the handler does not run

#### Scenario: Gated route works after enabling without restart
- **WHEN** an operator enables the flag and a new request hits the same route
- **THEN** the route runs normally without the API process having restarted

### Requirement: Admin-only audited toggling

The system SHALL provide an admin-only API to read and update feature flags, and an admin UI page that lists each flag with its state and toggle. Every flag change SHALL write an `audit_log` entry recording the actor, the flag, and the new value. Non-admins SHALL NOT be able to change flags.

#### Scenario: Admin toggles a flag
- **WHEN** an admin enables `agency_sourcing` from the Features page
- **THEN** the row is updated, an `audit_log` entry records the actor + flag + new value, and the change is published for cache invalidation

#### Scenario: Non-admin cannot toggle
- **WHEN** an operator or viewer attempts to change a flag
- **THEN** the API responds 403 and no change is persisted

#### Scenario: UI surfaces readiness for prerequisite-bound flags
- **WHEN** the Features page renders a flag whose runtime needs external setup (e.g. `object_storage` needs `S3_*`)
- **THEN** it shows a non-blocking prerequisites hint alongside the toggle

### Requirement: Behavior-preserving cutover

Replacing the compile-time flag reads with the accessor SHALL be behavior-preserving given the seeded values match the prior constants (all off). The public `/config` endpoint consumed by the web SHALL serve the DB-backed flag state.

#### Scenario: No behavior change on deploy
- **WHEN** the change is deployed with all flags seeded off
- **THEN** the running behavior is identical to the pre-change compile-time-flags-off behavior

#### Scenario: /config reflects DB state
- **WHEN** the web fetches `/config` after a flag is toggled on
- **THEN** the response reflects the new flag state from the database
