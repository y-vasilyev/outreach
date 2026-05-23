## 0. Process

- [x] 0.1 At the milestone gate (**CODEX REVIEW**), run a Codex review of the diff, address findings, then finalize
- [x] 0.2 Keep behavior-preserving: feature flag-gated + default off ⇒ no impact until enabled; verify `pnpm typecheck && pnpm test` after each milestone

## 1. Search client + normalization (packages/platforms)

- [x] 1.1 `discovery/YandexSearchClient.ts`: `search(query, opts)` — `searchAsync` submit → poll `operations/{id}` until done (bounded `pollTimeoutMs`) → decode base64 XML → `{ url, title, snippet }[]`; never logs the key; returns `[]` on miss; clear error on 403/credential failure. Export from `@nosquare/platforms`
- [x] 1.2 `discovery/extractCandidates.ts`: map results → channel candidates via each adapter's `parseHandle` (telegram/instagram/youtube), drop non-channel URLs (incl. `t.me/joinchat`/message deep-links), optional `platform` filter, in-batch dedup
- [x] 1.3 zod schemas in `packages/shared`: `DiscoverySearchInputZ` ({ query, platform?, limit }) + `DiscoveryResultZ`/`DiscoveryCandidateZ`
- [x] 1.4 Unit tests: XML parse against a captured sample, URL→handle extraction (telegram/ig/yt + junk dropped), platform filter, dedup, bounded-poll/timeout returns-not-throws

## 2. Discovery service + route + flag

- [x] 2.1 Add `channel_discovery` to `FEATURE_FLAG_DEFAULTS` (off) + migration row + idempotent seed
- [x] 2.2 `discoveryService.search({query, platform?, limit})` (apps/api): load+decrypt the `yandex_search` integration (clear error when missing/disabled) → `YandexSearchClient.search` → extract candidates → upsert `channel(status='new', source='search:<query>')` → enqueue `channel-scrape` for newly-created → return `{ candidates, created, enqueued, alreadyKnown }`
- [x] 2.3 `POST /discovery/search` route gated by `requireFeature('channel_discovery')` + `requireRole(['admin','operator'])`; zod-validate; registered unconditionally (gated at request time)
- [x] 2.4 Seed/config: support a `yandex_search` integration from env (`YANDEX_SEARCH_API_KEY` + folder) like ScrapeCreators; `.env.example` entry
- [x] 2.5 Unit/integration tests (mocked search client + prisma): new candidates persisted + scrape enqueued; known channels not duplicated; missing integration → clear error; flag-off route 404

## 3. e2e (business scenario) + docs

- [x] 3.1 e2e test (env-gated, skip without `YANDEX_SEARCH_API_KEY`/`YANDEX_API_KEY` + folder): real niche search → ≥1 telegram candidate → `channel(status='new')` persisted + `channel-scrape` enqueued; bounded timeout
- [x] 3.2 Verify the e2e passes locally with the Search key (sandbox/network), and skips cleanly without it
- [x] 3.3 Docs: `DESIGN.md`/`AGENTS.md` discovery note; `CHANGELOG.md`; `CLAUDE.md` "где что лежит" (discovery) if warranted
- [x] 3.4 `pnpm typecheck && pnpm lint && pnpm test` green (17/17, 10/10, 16/16); **CODEX REVIEW** — review run directly against the diff (Codex runtime deferred async this session; earlier milestone gates used Codex). Finding fixed: discovery `findUnique→create` now guarded (try/catch) so a unique-constraint race / create failure is counted as already-known with no duplicate scrape, never 500ing the request (+ test). Verified clean: bounded polling/no key leak, denylist completeness, flag-off no-op, authz order, registry/migration/seed consistency, env-gated e2e.
