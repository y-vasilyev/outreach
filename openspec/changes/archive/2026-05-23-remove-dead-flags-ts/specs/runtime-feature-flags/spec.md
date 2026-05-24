## MODIFIED Requirements

### Requirement: Behavior-preserving cutover

Replacing the compile-time flag reads with the accessor SHALL be behavior-preserving given the seeded values match the prior constants (all off). The public `/config` endpoint consumed by the web SHALL serve the DB-backed flag state. Once the cutover is complete, the compile-time `flags.ts` module SHALL NOT contain operational rollout/kill-switch flags; any remaining product constants there shall either be wired to a real consumer or removed.

#### Scenario: No behavior change on deploy

- **WHEN** the change is deployed with all flags seeded off
- **THEN** the running behavior is identical to the pre-change compile-time-flags-off behavior

#### Scenario: /config reflects DB state

- **WHEN** the web fetches `/config` after a flag is toggled on
- **THEN** the response reflects the new flag state from the database

#### Scenario: No parallel compile-time flag module remains

- **WHEN** a developer searches the workspace for `packages/shared/src/flags.ts` or the `@nosquare/shared/flags` subpath export in `packages/shared/package.json`
- **THEN** neither exists; the runtime registry in `feature-flags.ts` is the single source of toggleable operational flags
