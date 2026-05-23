## Purpose

Discover candidate blogger channels by niche via the Yandex Search API and feed them into the existing channel intake (scrape → contact-extract), behind the runtime `channel_discovery` flag — the front of the agency-sourcing funnel.

## Requirements

### Requirement: Yandex Search client

The system SHALL include a Yandex Search client that, given a query and `{ apiKey, folderId }`, submits an async web search, polls the resulting operation until it completes (bounded by a configurable timeout), decodes the result, and returns typed results (`url`, `title`, `snippet`). The client SHALL NOT log the API key and SHALL never throw on a search miss — an empty result set is returned instead.

#### Scenario: A query returns parsed results
- **WHEN** the client searches a non-empty query with a valid Search-API key + folder
- **THEN** it returns an array of results, each with at least a `url`, parsed from the completed operation

#### Scenario: Bounded polling on a slow operation
- **WHEN** the search operation does not complete within the configured timeout
- **THEN** the client stops polling and returns the results gathered so far (or empty) without hanging or throwing

#### Scenario: Permission/credential failure surfaces clearly
- **WHEN** the key lacks Search-API access (e.g. HTTP 403)
- **THEN** the client raises a clear, machine-readable error and does not log the key

### Requirement: Results normalize to platform channel candidates

Discovery SHALL extract, from search results, only URLs that normalize to a known platform handle via the existing `PlatformAdapter.parseHandle` (telegram / instagram / youtube). Non-channel results SHALL be dropped. An optional `platform` filter SHALL narrow discovery to one platform. Candidates SHALL be de-duplicated within a batch.

#### Scenario: A telegram channel URL becomes a candidate
- **WHEN** a result URL is `https://t.me/<handle>`
- **THEN** it is normalized to `{ platform: 'telegram', handle: '<handle>' }` and included as a candidate

#### Scenario: Non-channel results are dropped
- **WHEN** a result URL does not normalize to any platform handle (e.g. a news article, or a `t.me/joinchat/...` invite/message deep-link)
- **THEN** it is not included as a candidate

#### Scenario: Platform filter narrows discovery
- **WHEN** the request specifies `platform = 'telegram'`
- **THEN** only telegram candidates are returned

### Requirement: Discovery feeds the existing channel intake

The discovery service SHALL, for each new candidate, upsert a `channel` row (`status='new'`, `source='search:<query>'`) and enqueue the existing `channel-scrape` job for newly-created channels, reusing the unchanged downstream scrape → extract pipeline. Already-known channels SHALL NOT be duplicated or re-enqueued. The response SHALL report candidates found, channels created, channels enqueued, and how many were already known.

#### Scenario: New candidates are persisted and queued for scraping
- **WHEN** discovery finds candidates not already in `channel`
- **THEN** each is upserted as a `channel(status='new', source='search:<query>')` and a `channel-scrape` job is enqueued for it

#### Scenario: Known channels are not duplicated
- **WHEN** a discovered candidate already exists as a `channel` (same platform+handle)
- **THEN** no duplicate row is created, no new scrape is enqueued, and it is counted as already-known

### Requirement: Search key stored encrypted as an integration

The Yandex Search API key SHALL be stored as an `integration` row (`kind='yandex_search'`) with the credentials encrypted, configurable like other integrations — never hardcoded or committed. The discovery service SHALL decrypt it at use time and SHALL fail with a clear error when the integration is missing or disabled.

#### Scenario: Missing integration yields a clear error, not a crash
- **WHEN** discovery is invoked but no enabled `yandex_search` integration is configured
- **THEN** the API responds with a clear error indicating the integration is not configured, and no channels are created

#### Scenario: Credentials are never logged
- **WHEN** discovery runs at any log level
- **THEN** the Search API key never appears in logs (redacted)

### Requirement: Discovery is gated by a runtime feature flag

The discovery endpoint SHALL be gated behind the runtime feature flag `channel_discovery` (default off) and require an admin or operator role. When the flag is off the endpoint SHALL respond 404 (feature disabled); toggling the flag SHALL change availability without a restart.

#### Scenario: Endpoint is 404 when the flag is off
- **WHEN** `channel_discovery` is off and a request hits the discovery route
- **THEN** the API responds 404 and no search is performed

#### Scenario: Endpoint works after enabling without restart
- **WHEN** an admin enables `channel_discovery` and a request hits the route
- **THEN** discovery runs normally without the API process having restarted

### Requirement: End-to-end business-scenario coverage

The change SHALL include an end-to-end test that, when a Search-API key + folder are provided via environment, performs a real search for a niche and verifies the discovery scenario closes: at least one channel candidate is discovered and persisted as a `channel(status='new')` with a scrape enqueued. The test SHALL skip cleanly (not fail) when the key is absent, so offline CI is unaffected.

#### Scenario: Real search discovers and queues a channel
- **WHEN** the e2e test runs with a valid Search-API key + folder in env and searches a niche likely to surface telegram channels
- **THEN** the discovery service returns ≥1 candidate, a corresponding `channel(status='new')` exists, and a `channel-scrape` job was enqueued

#### Scenario: e2e skips without credentials
- **WHEN** the test runs with no Search-API key in env
- **THEN** the e2e case is skipped (not failed) and the rest of the suite runs offline
