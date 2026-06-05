## Purpose

After a redeploy, browsers holding a pre-deploy `index.html` can request lazy chunks whose hashes no longer exist. This capability ensures the web app auto-recovers from a failed dynamic import with a single guarded reload, and does not request capability endpoints whose flags are reported off in the public `/config` snapshot.
## Requirements
### Requirement: Client auto-recovers from a failed dynamic import

The web app SHALL detect a failed lazy-chunk import (Vite `vite:preloadError` and Vue Router navigation error for a module load failure) and SHALL perform a single full-page reload to pull the freshly deployed `index.html` and its matching chunk hashes. The recovery SHALL be guarded so it triggers at most once per affected page load and SHALL NOT enter a reload loop when the chunk is genuinely unavailable.

#### Scenario: Stale tab recovers after a redeploy

- **WHEN** a browser holding a pre-deploy `index.html` navigates to a route whose lazy chunk hash no longer exists
- **THEN** the app performs one `location.reload()` and loads the current bundle
- **AND** the navigation completes after the reload

#### Scenario: No reload loop on a persistent failure

- **WHEN** a dynamic import keeps failing after a recovery reload has already occurred for that page load
- **THEN** the app does not reload again
- **AND** it surfaces the failure rather than reloading repeatedly

### Requirement: Client does not request capabilities reported as off

The web app SHALL read the public `GET /config` flag snapshot and SHALL NOT issue requests to a capability's endpoint when its flag is reported off. Specifically, the inbox data-collection HUD query SHALL be enabled only when `data_collection_hud` is on, so no `/conversations/:id/data-collection` request (and no resulting `404`) is made while the feature is disabled.

#### Scenario: HUD query suppressed when the flag is off

- **WHEN** an operator opens a conversation while `data_collection_hud` is off in the `/config` snapshot
- **THEN** the client issues no `GET /conversations/:id/data-collection` request
- **AND** the browser console shows no `data-collection 404`

#### Scenario: HUD query active when the flag is on

- **WHEN** `data_collection_hud` is on in the `/config` snapshot and an operator opens a conversation
- **THEN** the client issues the `GET /conversations/:id/data-collection` request and renders the HUD
