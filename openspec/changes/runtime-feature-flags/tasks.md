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
- [x] 2.7 **CODEX REVIEW** — milestone 2 (API/worker cutover + route gating). No blockers. Fixed: (SF1) Redis subscriber no longer `await`s subscribe at boot (could hang if Redis down → process never starts); now subscribes + reloads on the `'ready'` event with `enableOfflineQueue:false` + an error handler, so boot is fail-safe and reconnect re-subscribes; publish hardened to fail fast + caught. (SF2) storage integration test no longer asserts the removed flag-off path (storage is flag-agnostic; gate lives at call sites). Confirmed clean: route gating before auth, callNotFound short-circuit, call-site object_storage guards, no compile-time flag leakage.

## 3. Admin API + UI

- [x] 3.1 Admin-only flags API: `GET /feature-flags` (list with state + readiness hints), `PATCH /feature-flags/:key` (toggle); write `audit_log`; publish invalidation on change — route `apps/api/src/routes/feature-flags.ts` (admin-only, registered UNCONDITIONALLY in index.ts), service `apps/api/src/services/feature-flags.ts`; zod enum from FEATURE_FLAG_KEYS validates `:key`, body via zod; on write: upsert row (enabled + updatedById from req.user) → `auditService.log('feature_flag.update')` → `publishFeatureFlagsChanged()`
- [x] 3.2 Web Settings → Features page (admin): `apps/web/src/features/settings/FeaturesPage.vue` lists flags from `GET /feature-flags` with a Switch per flag + description + readiness hint; PATCH on toggle invalidates `['feature-flags']` AND `['config']` (nav `useFlags()` updates live); admin-only route `settings/features` + Rail nav entry gated on `user.role === 'admin'` + router `meta.admin` guard
- [x] 3.3 Readiness hints (`evaluateReadiness` in the service, best-effort/never throws): `object_storage` → ready iff S3_ENDPOINT/S3_ACCESS_KEY/S3_SECRET_KEY/S3_BUCKET set; `agency_sourcing` → ready iff ≥1 enabled endpoint AND ≥1 tg_account; `blogger_matching` → ready iff ≥1 blogger_profile (else "каталог пуст — сначала соберите профили"); `campaign_types` → always ready; on query error → ready:false + neutral hint (no 500). Hints are non-blocking Russian strings — never block the toggle
- [x] 3.4 Tests: `apps/api/src/routes/__tests__/feature-flags.test.ts` (10) — admin PATCH updates row + audit_log + publish (all mocked); operator/viewer → 403, nothing persisted/published; unauth → 401; unknown key/bad body → 400; GET returns all keys with resolved state + readiness; readiness ready-path + throw-path (no 500). `pnpm --filter @nosquare/api test` 44/44 green; `pnpm --filter @nosquare/web typecheck` + build green
- [ ] 3.5 **CODEX REVIEW** — milestone 3 (admin API + UI)

## 4. Docs & rollout

- [ ] 4.1 Update `CLAUDE.md` (flags now in DB+UI, env `FEATURE_*_FORCE` override), `DESIGN.md` (feature_flag table + accessor + invalidation), `.env.example` (`FEATURE_*_FORCE`)
- [ ] 4.2 CHANGELOG.md entry
- [ ] 4.3 `pnpm typecheck && pnpm lint && pnpm test` green; **CODEX REVIEW** — final pass over the full change
