## Why

Sourcing ~200 bloggers currently starts with manually pasting channel lists / CSV. The front of the funnel — *finding* candidate channels by niche — is unautomated. The Yandex Search API (verified working with a Search-scoped key) lets us discover candidate channels by topic and feed them straight into the existing scrape → contact-extract intake. This closes the discovery step of the agency-sourcing business scenario: **"give me a niche → get candidate blogger channels queued for sourcing."**

## What Changes

- Add a **Yandex Search client** (`packages/platforms` discovery): async `searchAsync` submit → poll the operation → decode the result XML → typed results (`url`, `title`, `snippet`).
- Add a **channel-discovery service**: run a search for a query, extract platform channel URLs from the results (`t.me/…`, `instagram.com/…`, `youtube.com/@…`), normalize each via the existing `PlatformAdapter.parseHandle`, dedup, **upsert `channel` rows** (`status=new`, `source='search:<query>'`) and enqueue the existing `channel-scrape` job — so discovered channels flow through the unchanged downstream pipeline.
- Store the Search API key as an **`integration`** row (`kind='yandex_search'`, encrypted), configurable from the UI like ScrapeCreators — never in code.
- Add an API route **`POST /discovery/search`** (`{ query, platform?, limit }`) returning discovered candidates + how many channels were created/enqueued.
- Gate the whole feature behind a **runtime feature flag `channel_discovery`** (uses the runtime-feature-flags system: DB-backed, admin-toggle, default off).
- Add **e2e tests that close the business scenario**: with the Search key in env, a real query discovers ≥1 telegram channel candidate, persists it as a `channel`, and enqueues a scrape — env-gated so CI without the key skips cleanly.

## Capabilities

### New Capabilities
- `channel-discovery`: discover candidate blogger channels by niche via the Yandex Search API, normalize results into platform handles, and feed them into the existing channel intake (scrape → extract), behind a runtime flag.

### Modified Capabilities
<!-- None: reuses the existing channel intake (channel-scrape / contact-extract) and the runtime-feature-flags registry without changing their requirements. -->

## Impact

- **`packages/platforms`**: new `discovery/YandexSearchClient.ts` (async submit+poll+XML parse) + a result→channel URL extractor; exported.
- **`packages/shared`**: zod schemas (`DiscoverySearchInput`, `DiscoveryResult`); add `channel_discovery` to the feature-flag registry (`FEATURE_FLAG_DEFAULTS`) + migration/seed row (default off).
- **`apps/api`**: discovery service (search → parse → upsert channels → enqueue scrape) + `POST /discovery/search` route gated by `requireFeature('channel_discovery')` + role; reads the `yandex_search` integration key (decrypted).
- **DB**: no new tables — reuses `channel` + the `integration` table (`kind='yandex_search'`). Migration only seeds the new flag row.
- **Workers**: none new — reuses the existing `channel-scrape` queue.
- **Tests**: unit (XML parse, URL→handle extraction, dedup) + e2e (real search → discovered+persisted channels, env-gated skip).
- **Docs**: `DESIGN.md`/`AGENTS.md` discovery note; `.env.example` + integration config.
- **Secrets**: Search key stored encrypted in `integration`; e2e reads `YANDEX_SEARCH_API_KEY`/`YANDEX_API_KEY` + folder from env, never committed.
