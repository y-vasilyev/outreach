## 0. Process

- [ ] 0.1 At each milestone gate (**CODEX REVIEW**), run a Codex review of the milestone diff, address findings, then proceed
- [ ] 0.2 Keep behavior-preserving: all flags seeded off ⇒ no runtime change until toggled; verify after each milestone (`pnpm typecheck && pnpm test`)

## 1. Store + accessor (foundation)

- [x] 1.1 Add `feature_flag` model to `schema.prisma` + migration `8_feature_flags`; seed known keys with defaults (followup_cron=true, rest off); idempotent upsert in seed.ts (never overwrites operator toggles)
- [x] 1.2 Flag registry (`FEATURE_FLAG_DEFAULTS` keys+defaults) in `packages/shared/src/feature-flags.ts` derived from flags.ts; closed set the accessor validates against (unknown → off)
- [x] 1.3 `FeatureFlags` accessor: sync `get(key)`, async `init()`/`refresh()`, env-force resolution (`FEATURE_<KEY>_FORCE`); order env > cache > default; fail-safe to defaults when store unreachable; `snapshot()` for /config
- [x] 1.4 Redis pub/sub invalidation: `FEATURE_FLAGS_CHANNEL` constant + injected `FeatureFlagSubscriber` (reload on message; subscribe failure non-fatal). IO injected per app (shared stays pure)
- [x] 1.5 Unit tests (7): get() sync+cached (no per-call query), env force-floor off/on, unknown→off, fail-safe defaults, publish→reload, snapshot
- [ ] 1.6 **CODEX REVIEW** — milestone 1 (store + accessor + invalidation)

## 2. Wire accessor into API & workers

- [ ] 2.1 Initialize `FeatureFlags` at API boot (load cache + subscribe) and at workers boot
- [ ] 2.2 `requireFeature(key)` Fastify preHandler (404 when off); register agency/campaign-types/blogger-matching/media-assets routes unconditionally, gated by it (compose before `requireRole`)
- [ ] 2.3 Replace `flags.ENABLE_*` reads with `featureFlags.get(...)` in workers: `agent-run.ts` (isAgencyConversation, resolveRoleAgent, safetyExtras, force-handoff, profile-extract trigger), `campaign-dispatcher.ts`, `tg-listen.ts`
- [ ] 2.4 Replace flag reads in API: `campaigns` service (reject non-custdev typeId), any other `flags.ENABLE_*` site
- [ ] 2.5 Make `/config` endpoint DB-backed (serve resolved flag state)
- [ ] 2.6 Regression tests: gated route 404 when off / 200 after enable (no restart); CustDev path unchanged with all flags off; worker hot path reads cached accessor
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
