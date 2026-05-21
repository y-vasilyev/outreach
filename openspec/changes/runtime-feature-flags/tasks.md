## 0. Process

- [ ] 0.1 At each milestone gate (**CODEX REVIEW**), run a Codex review of the milestone diff, address findings, then proceed
- [ ] 0.2 Keep behavior-preserving: all flags seeded off ⇒ no runtime change until toggled; verify after each milestone (`pnpm typecheck && pnpm test`)

## 1. Store + accessor (foundation)

- [x] 1.1 Add `feature_flag` model to `schema.prisma` + migration `8_feature_flags`; seed known keys with defaults (followup_cron=true, rest off); idempotent upsert in seed.ts (never overwrites operator toggles)
- [x] 1.2 Flag registry (`FEATURE_FLAG_DEFAULTS` keys+defaults) in `packages/shared/src/feature-flags.ts` derived from flags.ts; closed set the accessor validates against (unknown → off)
- [x] 1.3 `FeatureFlags` accessor: sync `get(key)`, async `init()`/`refresh()`, env-force resolution (`FEATURE_<KEY>_FORCE`); order env > cache > default; fail-safe to defaults when store unreachable; `snapshot()` for /config
- [x] 1.4 Redis pub/sub invalidation: `FEATURE_FLAGS_CHANNEL` constant + injected `FeatureFlagSubscriber` (reload on message; subscribe failure non-fatal). IO injected per app (shared stays pure)
- [x] 1.5 Unit tests (7): get() sync+cached (no per-call query), env force-floor off/on, unknown→off, fail-safe defaults, publish→reload, snapshot
- [x] 1.6 **CODEX REVIEW** — milestone 1 (store + accessor + invalidation). Fixed: (B1) scoped the runtime registry to the 4 agency rollout flags — all default OFF (followup_cron/quality_review stay compile-time flags, untouched), so the spec's "all off" holds and behavior is preserved; (B2) `init()` now subscribes BEFORE the initial refresh (no missed-message window) + documented that the injected subscriber must re-fire onChange on Redis reconnect; (S1) `init()` logs pinned `FEATURE_<KEY>_FORCE` overrides; (S2) seed derives keys/defaults from the shared registry (no 3-way drift); (N1) refresh() comment corrected to "last-known-good". S3 (PascalCase table) kept — matches every other table in the schema.

## 2. Wire accessor into API & workers

- [x] 2.1 Initialize `FeatureFlags` at API boot + workers boot (`apps/{api,workers}/src/feature-flags.ts` accessor singleton + prisma loader + dedicated Redis subscriber that reloads on message AND on (re)connect; `initFeatureFlags()` called before listen/before workers start)
- [x] 2.2 `requireFeature(key)` preHandler (`reply.callNotFound()` plain 404 when off — same shape as an unregistered route, so the web's feature-off detection still works); gated route plugins (campaign-types, campaign-type-builder, blogger-profiles, media-assets, matching) registered unconditionally + gated via the hook
- [x] 2.3 Replaced `flags.ENABLE_*` reads in workers: `agent-run.ts` (4), `campaign-dispatcher.ts`, `profile-extract.ts`, `tg-listen.ts` (2), `media-store.ts` (2) → `getFeatureFlags().get(...)`; storage pkg `getObjectStore` now gates on config only (flag check moved to call sites)
- [x] 2.4 Replaced API flag reads: `campaigns` service (reject non-custdev typeId) → accessor
- [x] 2.5 `/config` DB-backed (serves `getFeatureFlags().snapshot()`, resolved through env force-override)
- [x] 2.6 Regression tests: `require-feature.test.ts` (404 off / passthrough after enable, no restart); worker hot-path tests (agencyRouting, mediaStore) re-driven via the mocked accessor; CustDev path unchanged with flags off
- [ ] 2.7 **CODEX REVIEW** — milestone 2 (API/worker cutover + route gating)

## 3. Admin API + UI

- [ ] 3.1 Admin-only flags API: `GET /feature-flags` (list with state + readiness hints), `PATCH /feature-flags/:key` (toggle); write `audit_log`; publish invalidation on change
- [ ] 3.2 Web Settings → Features page (admin): list flags with toggles + prerequisite hints; persist via the API; reflect state from `/config`/list
- [ ] 3.3 Readiness hints: annotate `object_storage` (needs `S3_*`), `agency_sourcing` (needs endpoints + TG accounts) — non-blocking
- [ ] 3.4 Tests: admin can toggle (audited + published), non-admin gets 403, list returns state + hints; web typecheck/build
- [ ] 3.5 **CODEX REVIEW** — milestone 3 (admin API + UI)

## 4. Docs & rollout

- [ ] 4.1 Update `CLAUDE.md` (flags now in DB+UI, env `FEATURE_*_FORCE` override), `DESIGN.md` (feature_flag table + accessor + invalidation), `.env.example` (`FEATURE_*_FORCE`)
- [ ] 4.2 CHANGELOG.md entry
- [ ] 4.3 `pnpm typecheck && pnpm lint && pnpm test` green; **CODEX REVIEW** — final pass over the full change
