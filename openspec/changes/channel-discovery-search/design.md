## Context

The Yandex Cloud Search API v2 was verified working with a Search-scoped key (`searchAsync` → operation → poll → base64 XML result, ~10 docs). The codebase has no web-search/discovery yet: channels are added via CSV/manual paste, then `channel-scrape` → `contact-extract` run. Platform handle parsing already exists (`PlatformAdapter.parseHandle` per platform via `platformRegistry`). Secrets live encrypted in `integration` (ScrapeCreators pattern) / `endpoint`. Feature flags are now runtime/DB-backed (runtime-feature-flags), read via `getFeatureFlags().get(key)` and gated at routes by `requireFeature`.

## Goals / Non-Goals

**Goals:**
- Given a niche query, discover candidate blogger channels and queue them for the existing sourcing pipeline — no change to scrape/extract.
- Reuse existing primitives: `integration` (encrypted key), `channel` + `channel-scrape`, `platformRegistry.parseHandle`, the runtime flag system.
- An e2e test that closes the business scenario against the real Search API, env-gated (skips without a key).
- Default off; zero impact until the `channel_discovery` flag is enabled.

**Non-Goals:**
- A generic multi-provider search abstraction (Yandex only for now; the client is isolated so another provider can be added later).
- Ranking/quality scoring of discovered channels (they enter as `status=new` and the existing analysis/extraction decides fitness).
- Synchronous search (the API is async submit+poll — we live with the latency, bounded by a timeout).
- Discovering non-channel web pages as leads (we only keep results that normalize to a known platform handle).

## Decisions

### D1: Async submit + poll client, isolated in `packages/platforms/discovery`
`YandexSearchClient.search(query, opts)` POSTs `searchAsync`, polls `operations/{id}` until `done` (bounded by `pollTimeoutMs`, default ~45s, fixed interval), decodes `response.rawData` (base64 XML), and parses `<doc>` entries into `{ url, title, snippet }[]`. It takes `{ apiKey, folderId, baseUrl? }` (mirrors the endpoint-style config) and never logs the key. Lives next to the platform adapters (the package that owns "channels from the outside world"); exported from `@nosquare/platforms`.

*Alternative*: the legacy XML search GET endpoint (`yandex.<tld>/search/xml`). Rejected — different (older) product/registration; the Cloud v2 API matches the verified key.

### D2: Results → channel candidates via existing `parseHandle`
For each result URL, try each registered platform adapter's `parseHandle`; the first that returns `{handle}` determines `platform`+`handle`. Filter to channel-shaped URLs (`t.me/…` excluding `/joinchat`/message deep-links, `instagram.com/<user>`, `youtube.com/@…|/channel/…|/c/…`). Optional `platform` input narrows discovery. Dedup within the batch and against existing `channel` rows (`@@unique(platform, handle)` already enforces it).

### D3: Discovery service orchestrates; downstream is unchanged
`discoveryService.search({ query, platform?, limit })`: load the `yandex_search` integration (decrypt key) → `YandexSearchClient.search` → extract candidates → `channel.upsert({ platform, handle }, { status:'new', source:'search:<query>' })` → enqueue `channel-scrape` for newly-created channels (idempotent, same path as CSV import). Returns `{ candidates: [...], created, enqueued, alreadyKnown }`. The scrape→extract pipeline then runs untouched.

*Alternative*: a new `discovery` worker queue. Rejected — the API can do the (bounded) search inline and the heavy work is the existing `channel-scrape` queue; no new queue needed.

### D4: Key in `integration`, feature behind a runtime flag
Store the Search key as `integration(kind='yandex_search', configEncrypted={apiKey, folderId, baseUrl?})` — encrypted, UI-configurable, consistent with ScrapeCreators. Gate the route with `requireFeature('channel_discovery')` (404 when off) + `requireRole(['admin','operator'])`. Add `channel_discovery` to the runtime flag registry (default off) so enabling discovery is an audited admin toggle, no redeploy.

### D5: e2e closes the scenario, env-gated
The e2e test runs only when `YANDEX_SEARCH_API_KEY` (or `YANDEX_API_KEY`) + folder are in env (mirrors the MinIO integration test's skip-if-unreachable). It performs a real search for a niche, asserts ≥1 telegram channel candidate is discovered and that calling the discovery service persists a `channel(status=new)` and enqueues a scrape — i.e. the discovery business scenario completes end to end. Unit tests (XML parse, URL→handle extraction, dedup, integration-missing degradation) run always and offline.

## Risks / Trade-offs

- **[Search latency / async polling]** → bounded `pollTimeoutMs`; on timeout return the candidates found so far / a clear "pending" result rather than hanging. e2e uses a generous timeout (≤90s).
- **[Result XML format drift]** → parser is defensive (regex/lenient extraction of `<url>`/`<title>`; tolerate missing fields); unit-tested against a captured sample. A parse miss yields fewer candidates, never a crash.
- **[Search key lacks Search-API role]** (observed: the LLM key 403s) → the service surfaces a clear error from the integration; discovery is flag-gated and separate from the LLM endpoints, so it never affects agent runs.
- **[Discovering junk/irrelevant channels]** → only results that normalize to a platform handle are kept; they enter as `status=new` and the existing `ChannelAnalyzer`/`ContactExtractor` + operator review gate fitness. No auto-outreach from discovery.
- **[External call in a request]** → bounded + flag-gated + admin/operator only; not on any hot path.

## Migration Plan

1. Add `channel_discovery` to `FEATURE_FLAG_DEFAULTS` (off) + a migration/seed row.
2. Land the client + service + route (flag-gated) + zod schemas.
3. Configure the `yandex_search` integration (encrypted key) via seed-from-env / UI.
4. Rollout: deploy is a no-op (flag off). Enable from the admin Features page when ready; rollback = toggle off (or `FEATURE_CHANNEL_DISCOVERY_FORCE=off`).

## Open Questions

- Should discovery also accept an explicit list of niches/queries for batch sourcing (200 bloggers), or one query per call for v1? (Leaning v1: one query per call; batch is a thin loop on top later.)
- De-dup against `contact`/already-contacted channels to avoid re-discovering worked leads — useful but out of v1 scope (the `(platform,handle)` unique + `status` already prevent re-scraping).
