## Why

Feature flags are currently compile-time constants in `packages/shared/src/flags.ts` (`as const`, all read directly as `flags.ENABLE_*`). Toggling one — e.g. turning on `ENABLE_AGENCY_SOURCING` for a pilot, or killing it during a TG-ban incident — requires a code edit, rebuild and redeploy. Every other operational knob in this system already lives in the DB and is editable from the UI (agent prompts, endpoints, integrations, campaign types); feature flags are the lone exception. We want a **runtime, DB-backed, UI-managed** flag system so operators can flip features (and instantly kill risky outreach) without a deploy.

## What Changes

- Introduce a `feature_flag` table (one row per flag: `key`, `enabled`, `description`, audit fields) as the source of truth, seeded with the existing flags defaulted **off** (fail-safe).
- Add a `FeatureFlags` service with a **synchronous in-memory cache** so hot paths (the inbound worker reads flags per message) stay fast; cache is refreshed via **Redis pub/sub invalidation** so the API and worker processes both see a toggle immediately.
- **BREAKING (internal)**: replace direct `flags.ENABLE_*` reads (~10 sites in API + workers) with the cached accessor. API routes stop being registered conditionally at boot and are instead gated by a `requireFeature(key)` preHandler (so toggling works without a restart).
- Admin-only **Settings → Features** UI page listing flags with toggles; changes persist via a new endpoint and write an `audit_log` entry (enabling agency outreach is a dangerous action). The existing `/config` endpoint becomes DB-backed.
- Optional **env emergency override** (`FEATURE_<KEY>_FORCE=off|on`) that always wins over the DB value — a kill-floor for incidents where the DB toggle is unavailable or untrusted.
- Default-off when the flag store is unreachable; UI surfaces a readiness hint for flags with external prerequisites (e.g. `object_storage` needs `S3_*`).

## Capabilities

### New Capabilities
- `runtime-feature-flags`: DB-backed feature-flag store with a cached, cross-process accessor; admin UI to toggle; audited writes; env emergency override; fail-safe defaults.

### Modified Capabilities
<!-- None: the compile-time flags were never a spec'd capability. -->

## Impact

- **DB** (`packages/db/prisma/schema.prisma`): new `feature_flag` table + migration seeding the known flags (off). 
- **Shared** (`packages/shared`): `flags.ts` direct-const reads are superseded; the canonical flag keys + defaults move behind the new accessor (the const map can remain as the seed/default source).
- **API** (`apps/api`): `FeatureFlags` accessor wired at boot (loads cache, subscribes to Redis); `requireFeature` preHandler; routes for agency/campaign-types/blogger-matching/media-assets registered unconditionally and gated; admin flags CRUD + audit; `/config` DB-backed.
- **Workers** (`apps/workers`): same accessor (loads cache, subscribes to Redis); `agent-run.ts`, `campaign-dispatcher.ts`, `tg-listen.ts`, campaign service reads switch to the cached accessor.
- **Web** (`apps/web`): Settings → Features admin page; `useFlags()` reads the DB-backed `/config`.
- **Infra**: uses the existing Redis (BullMQ / Socket.IO adapter) for pub/sub — no new dependency. New optional `FEATURE_*_FORCE` env.
- **Migration safety**: defaults off → enabling features stays a deliberate operator action; behavior is unchanged until a flag is flipped.
