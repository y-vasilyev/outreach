## Why

Phase 1 (`data-collection-hud-target-fields`) shipped a TS-side registry of target fields. It is fixed at deploy time — an operator can't add a new field, edit a description, or change a TTL without a code change. We now want admin-edited fields, but it is too early to make the EAV store the source of truth: we don't yet know which keys we want, which scope (blogger vs. channel), or how migrations will work. Phase 2 lets the admin UI manage the field metadata while the data shape stays exactly where it is — `BloggerProfile` / `ProfileDataPoint` remain the only-source-of-truth, and the existing rollup keeps running unchanged.

The goal of Phase 2 is to introduce `entity_type` + `entity_field` as **read metadata only** — a place where the operator can edit labels, descriptions, TTLs, and field-key mappings; where the Phase 1 registry now reads from. No EAV writes, no dual-write, no behavior change to extractors or the rollup.

This is the second of four sequential phases. See also: `data-collection-hud-target-fields` (Phase 1, complete), `eav-write-path-dual-write` (Phase 3), `blogger-aggregate-and-catalog` (Phase 4).

## What Changes

- Add `entity_type` + `entity_field` Prisma models — but **read-only metadata**, not value storage. `entity_field` declares `{ key, label, description_for_operator, description_for_agent, question_template, freshness_section, profile_data_point_keys[], manual_only?, staleness_ttl_days?, order, enabled }`. Same shape as the Phase 1 TS registry, plus `staleness_ttl_days?` so the freshness helper can read a per-field TTL when set.
- Seed exactly one built-in entity type `blogger` whose fields reproduce today's Phase 1 registry entries one-for-one (`rate_card`, `reach`, `audience_demographics`, `geo`, `deals_contact`). Seeding SHALL be idempotent.
- Add `campaign_type.entity_type_id` (nullable). Set it on the seeded `agency_sourcing` campaign type pointing at the `blogger` entity type. CustDev stays untouched (nullable).
- Add an **admin editor** at `/settings/entity-types` (list) and `/settings/entity-types/:id` (editor). Operators can: edit display labels, descriptions, question templates, TTLs, the `profile_data_point_keys[]` match list (with validation that each key matches at least one observed `ProfileDataPoint.field` in the database — warning, not error), reorder, and disable fields. Adding new fields is allowed; the rollup keeps reading `ProfileDataPoint` regardless of whether a field is enabled, so disabling a field just hides it from the HUD/planner.
- Rewire Phase 1's registry resolution: `packages/shared/src/data-collection-targets.ts` now resolves entries from the DB-backed `entity_field` rows (cached in process, invalidated via Redis pub/sub like feature flags), falling back to the TS-side registry for environments where the DB is unreachable at boot or the type is not seeded. The TS-side registry stays as a fallback safety net.
- Add a **field-key mapping diagnostic**: a one-line dashboard on the editor showing, per `profile_data_point_keys[]`, how many `ProfileDataPoint` rows in the last 90 days match. Operators see immediately if a remap broke the link.
- Keep `BloggerProfile.rollup` and the existing `computeProfileFreshness` helper exactly as they are. The helper SHALL read `staleness_ttl_days` from the DB-backed metadata when present, falling back to today's per-section TTL constants when absent.
- Gate behind feature flag `entity_types_metadata` (default off). When OFF, the registry reverts to the Phase 1 TS-side behavior.

Non-goals for this change: no EAV value storage, no `entity_value` table, no dual-write, no agent field-tools, no Blogger aggregate, no snapshots, no catalog page. Field metadata is editable; data continues to flow through `ProfileDataPoint`.

## Capabilities

### New Capabilities

- `entity-type-registry`: DB-backed `entity_type` + `entity_field` (metadata only, no values). Idempotent seed of the built-in `blogger` type matching Phase 1's TS registry; admin CRUD endpoints and editor UI; cache + invalidation pattern reusing the feature-flag plumbing.

### Modified Capabilities

- `data-collection-target-fields`: the registry SHALL resolve entries from the DB-backed `entity_field` rows when the feature flag is on, falling back to the TS-side registry otherwise. Field-key match (`profile_data_point_keys[]`), descriptions, TTLs, and labels all move to the DB.
- `blogger-commercial-profile`: per-section TTLs in `computeProfileFreshness` SHALL be derived from each contributing field's `entity_field.staleness_ttl_days` when the linked entity type provides one, falling back to today's per-section constants. No change to source of truth — still `ProfileDataPoint`.
- `campaign-type-registry`: a campaign type MAY reference an `entity_type` via the new `entity_type_id`. When set, the data-collection HUD and planner resolve their field set from that entity type's fields.

## Impact

- **DB schema**: new `entity_type` + `entity_field` tables (metadata only — no value columns); `campaign_type.entity_type_id` nullable FK; idempotent seed of the `blogger` type. One Prisma migration.
- **Shared** (`packages/shared`): Phase 1's `data-collection-targets.ts` gains a DB-backed loader behind a cache; the TS-side registry stays as a fallback. New zod schemas for `entity_type` / `entity_field`. New feature-flag key `entity_types_metadata`.
- **API** (`apps/api`): `routes/entity-types.ts` (CRUD), `routes/entity-fields.ts` (add/edit/reorder/disable). Both gated by `requireFeature`. `routes/blogger-profiles.ts` and the staleness helper read the DB-backed TTLs.
- **Workers**: a Redis-backed invalidator on entity-field writes (same pattern as feature flags) so all processes refresh their cache.
- **Web** (`apps/web`): new `features/entity-types/` with list + editor pages; admin-role only; nav entry gated by the feature flag.
- **Rollout**: ship migration + seed + endpoints flag-off; flip ON in staging; the HUD instantly shows DB-backed labels but behavior is unchanged; flip ON in prod.
- **Risk**: low — metadata only. The only operator-visible behavior change is editable labels/TTLs, and `BloggerProfile`/`ProfileDataPoint`/rollup all stay where they are.
