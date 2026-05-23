## Context

Flags live in `packages/shared/src/flags.ts` as an `as const` object and are read synchronously as `flags.ENABLE_*` in ~10 places: API boot-time route registration (`apps/api/src/index.ts`), the inbound worker hot path (`apps/workers/src/queues/agent-run.ts` — per message), `campaign-dispatcher.ts`, `tg-listen.ts`, the campaign service, and the web `/config` consumer. Two long-lived processes (api, workers) each hold their own module state. Redis is already present (BullMQ queues + Socket.IO adapter). The codebase convention is "operational config lives in DB and is editable from the UI" (`agent_config`, `endpoint`, `integration`, `campaign_type`), with dangerous actions audited.

## Goals / Non-Goals

**Goals:**
- DB is the source of truth for the operational flags; toggling from the UI takes effect in both api and workers **without a redeploy or restart**.
- Hot-path reads stay synchronous and cheap (no per-message DB query).
- Fail-safe: unknown/unreachable store ⇒ flag is **off**.
- Toggling is admin-only and audited.
- An env override exists as an incident kill-floor.
- Zero behavior change until a flag is flipped (current state = all off).

**Non-Goals:**
- Per-tenant / per-user / percentage-rollout / targeting flags (these are global on/off switches).
- Replacing always-on product constants like `ENABLE_LLM_CONTACT_EXTRACTION` / `ENABLE_AUTO_MODE` (out of scope; only the rollout/kill-switch flags move — at minimum the agency-sourcing-matching set, with the table general enough to absorb others later).
- A generic experimentation/analytics platform.

## Decisions

### D1: `feature_flag` table as source of truth; const map becomes the seed/registry
`feature_flag(key PK/unique, enabled bool, description, updatedById, updatedAt)`. The known flag keys + their default values stay declared in code (a registry derived from today's `flags.ts`) and the migration/seed inserts them disabled. Code never invents flag keys at runtime — the registry is the closed set the UI renders and the accessor validates against (an unknown key reads as off).

*Alternative*: generic `app_setting(key, value JSONB)`. Rejected for now — a typed boolean flag table is clearer and matches the `integration`/`endpoint` table style; a generic settings store can come later.

### D2: Synchronous cached accessor, Redis pub/sub invalidation
A `FeatureFlags` service holds an in-memory `Map<key, boolean>`. `get(key): boolean` is **synchronous** (hot-path safe). `init()` loads the table once at process boot and subscribes to a Redis channel `feature_flags:changed`. A write (via the admin API) updates the row, then `PUBLISH feature_flags:changed`; every subscriber reloads the cache. Effect: a UI toggle propagates to api + workers within a round-trip, no restart.

*Alternatives considered*: (a) short TTL poll — simpler but adds latency + constant queries; pub/sub is cheap given Redis is already wired. (b) async `get()` everywhere — would force `await` into the synchronous hot path and the route-registration code; rejected.

### D3: Routes registered unconditionally, gated by `requireFeature(key)` preHandler
Boot-time `if (flags.X) app.register(...)` cannot react to a runtime toggle. Instead register the agency/campaign-types/blogger-matching/media-assets routes **always**, and add a `requireFeature(key)` Fastify preHandler that returns 404 (feature disabled) when the cached flag is off — composed before the existing `requireRole`. The web already distinguishes a feature-off 404 from a real not-found, so this is consistent.

*Alternative*: re-register routes on toggle — Fastify doesn't support clean runtime de/registration; rejected.

### D4: Env emergency override is a hard floor
`FEATURE_<KEY>_FORCE` (`off`/`on`) is read at accessor resolution and **overrides the DB value**. Primary use: force-off during an incident even if the DB row says on, or when the DB/cache is degraded. Resolution order: `env force` > `cached DB value` > `registry default (off)`. The override is logged at startup (redacted of nothing — it's not a secret) so operators know a flag is pinned.

### D5: Fail-safe + readiness hints
If `init()` can't read the table (DB down at boot), the cache stays at registry defaults (off) and a warning is logged; the process still starts. The UI annotates flags whose runtime needs external prerequisites (`object_storage` ⇒ `S3_*` configured; `agency_sourcing` ⇒ endpoints + TG accounts) with a non-blocking "prerequisites" note, so an operator isn't surprised when an enabled feature degrades.

### D6: Migration & cutover keep behavior identical
The migration seeds every known flag `enabled=false` — exactly today's effective state. Each `flags.ENABLE_*` read site is swapped to `featureFlags.get('...')` in the same change; because the seeded values match the old constants, the swap is behavior-preserving. The `flags.ts` const stays as the default/registry source (single place that lists keys + defaults), so there's no duplication drift.

## Risks / Trade-offs

- **[Cache staleness across processes]** → Redis pub/sub invalidation on every write; on reconnect the subscriber reloads. A missed message window is bounded by also reloading on subscribe/reconnect. Worst case a toggle is briefly not seen by one process — acceptable for on/off ops switches, and the env force-floor covers true emergencies.
- **[DB unreachable at boot ⇒ flags wrong]** → default-off is the safe direction (we never auto-enable agency outreach); logged loudly.
- **[Operator enables a feature whose prerequisites aren't met]** → storage path already degrades safely (warn, don't drop the conversation); UI shows readiness hints; enabling is audited so it's traceable.
- **[Hot-path correctness]** → `get()` is a synchronous map read; the only async work is `init()`/reload, off the message path. Unit-test that a published change updates the cache.
- **[Scope creep into a full flag platform]** → explicitly bounded to global boolean rollout/kill switches with a closed registry.

## Migration Plan

1. Migration: create `feature_flag`; seed the known keys (`campaign_types`, `agency_sourcing`, `object_storage`, `blogger_matching`, + any other rollout flags chosen) with `enabled=false`. Idempotent upsert in seed.ts too.
2. Land the `FeatureFlags` accessor + `init()` wiring in api and workers boot.
3. Swap read sites + convert route registration to `requireFeature`. Make `/config` DB-backed.
4. Add admin flags API + UI page (audited).
5. Rollout: deploy is a no-op (all off). Pilots are enabled from the UI thereafter. Rollback: env `FEATURE_*_FORCE=off` or toggle off in UI; no redeploy.

## Open Questions

- Scope of which flags migrate: only the 4 agency-sourcing rollout flags, or also the older operational ones (`ENABLE_FOLLOWUP_CRON`, `ENABLE_QUALITY_REVIEW`)? Leaning: migrate the rollout/kill-switch flags (the 4 + quality_review + followup_cron), leave pure product constants (`ENABLE_LLM_CONTACT_EXTRACTION`, `ENABLE_AUTO_MODE`) as code for now — but the table accepts them later.
- Should toggling a flag also emit a realtime `admin:dashboard` event so other operators' UIs update live? (Nice-to-have; the Redis channel already exists to piggyback on.)
