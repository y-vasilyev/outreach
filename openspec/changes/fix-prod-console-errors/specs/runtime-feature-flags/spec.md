## MODIFIED Requirements

### Requirement: Behavior-preserving cutover

Replacing the compile-time flag reads with the accessor SHALL be behavior-preserving given the seeded values match the prior constants (all off). The public `/config` endpoint consumed by the web SHALL serve the DB-backed flag state, and its snapshot SHALL include the `data_collection_hud` flag (in addition to the agency-rollout flags) so the web can gate client-side data-collection requests on it. Once the cutover is complete, the compile-time `flags.ts` module SHALL NOT contain operational rollout/kill-switch flags; any remaining product constants there shall either be wired to a real consumer or removed.

#### Scenario: No behavior change on deploy

- **WHEN** the change is deployed with all flags seeded `false`
- **THEN** every flag-gated route and UI surface behaves exactly as before the cutover (all off)

#### Scenario: /config reflects DB state

- **WHEN** the web fetches `/config` after a flag is toggled on
- **THEN** the returned snapshot reports that flag as enabled

#### Scenario: /config exposes the data-collection HUD flag

- **WHEN** the web fetches `/config`
- **THEN** the snapshot includes a `dataCollectionHud` boolean mirroring the `data_collection_hud` DB-backed flag state

#### Scenario: No parallel compile-time flag module remains

- **WHEN** the cutover is complete
- **THEN** the compile-time `flags.ts` module contains no operational rollout/kill-switch flags
