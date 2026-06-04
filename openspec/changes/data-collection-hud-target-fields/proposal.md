## Why

In `agency_sourcing` conversations today the operator can't see at a glance what the bot has already collected, what it's still missing, what it asked about with no answer, and which collected facts have gone stale. The data is there — `ProfileDataPoint` rows on `BloggerProfile`, the planner's `target_data_points`, the existing `profile-staleness` helper — but it's never composed into a single view next to the chat. Operators have to open the blogger profile in another tab and reason about it manually.

The planner already understands targets, but those targets are bare strings (`rate_card`, `reach`, `audience_demographics`, `geo`) with no human label, no agent guidance, no link to a freshness section, and no consistent description shared between the planner's prompt and the operator's UI. Each piece is restated in different code paths.

This change gives operators the live HUD they need now, without rewriting the profile model. It is the first of four sequential phases laid out in the roadmap (see also: `entity-types-shadow-metadata`, `eav-write-path-dual-write`, `blogger-aggregate-and-catalog`).

## What Changes

- Add a typed **target-field registry** in `packages/shared`: each entry `{ key, label, description_for_operator, description_for_agent, freshness_section, profile_data_point_keys[] }`. The `profile_data_point_keys[]` list uses the existing exact-or-dotted-subkey semantics from `agent-run.ts` (`rate` matches `rate.post`, `audience.geo` matches `audience.geo.ru`) via one shared helper. v1 contains the four automated agency targets (`rate_card`, `reach`, `audience_demographics`, `geo`) plus `deals_contact` (no auto-capture path yet — operator-only).
- Per campaign, the **HUD target list** is resolved from `campaign.goal.target_data_points` (existing behavior) intersected with the registry — entries the registry doesn't know are dropped with a warning so the HUD never shows untyped blobs. The **planner target list** uses the same resolution but excludes `manual_only` targets, so operator-only gaps are visible without blocking the automated planner.
- Add the **data-collection HUD endpoint** `GET /conversations/:id/data-collection` returning `{ campaignTypeKey, targets: [{ key, label, description_for_operator, freshness_section, state, current?: { value, capturedAt, sourceMessageId? }, lastAskedAt?, freshness?: { stale, ageDays } }] }`. State ∈ `answered | asked | missing | stale` derived from existing `ProfileDataPoint` rows, the conversation's `Suggestion.meta.targetField` history, and target-local freshness: for each target, filter data points by the registry match helper first, then call the existing `profile-staleness` helper and read that target's section.
- Add `Suggestion.meta.targetField` write at the planner site so the HUD can mark a target `asked` even before any answer arrives. Planner output stays snake_case (`target_field`); persisted suggestion metadata uses camelCase (`targetField`). The shape is documented in the registry; no schema migration.
- Wire the **planner** (`DataCollectionPlanner`) to consume the registry: instead of hardcoded `QUESTION_TEMPLATES` keyed by raw strings, it reads `description_for_agent` from the registry and only receives non-`manual_only` targets so the operator can tune the bot's tone by editing one TS module (and the HUD shows the same text as a tooltip on `missing` fields).
- Add WS event `dataCollectionUpdated` (`{ conversationId, targetKey, state, current?, freshness? }`) emitted by the process that writes the relevant row (today: `profile-extract` / `agent-run` workers through the existing Redis realtime bridge) after every `ProfileDataPoint` write and every suggestion-with-targetField creation; the inbox right panel patches in place.
- Add a thin **right panel** in `apps/web/src/features/inbox/` that consumes the endpoint + WS event. Each row shows label, current value, source-link (scrolls inbox to source message when present), state badge, freshness badge, and a "draft a question" button on `missing` rows that pre-fills the composer with `description_for_operator`.
- Gate the new endpoint, WS event, and UI panel behind feature flag `data_collection_hud` (default off) so the rollout is reversible per-environment.

Non-goals for this change: no new tables, no EAV, no Blogger aggregate, no entity-type admin editor, no snapshots, no versioning, no catalog page. `BloggerProfile` / `ProfileDataPoint` stay the source of truth and only-source-of-truth.

## Capabilities

### New Capabilities

- `data-collection-target-fields`: typed registry of target fields per campaign type (key, label, operator + agent descriptions, freshness-section mapping, `ProfileDataPoint`-key match list). Single source of truth shared by the planner, the HUD, and (later) the gate.
- `data-collection-hud`: `GET /conversations/:id/data-collection` endpoint + `dataCollectionUpdated` WS event + inbox right panel showing `answered | asked | missing | stale` per target with current value, freshness, and a source link.

### Modified Capabilities

- `agency-sourcing-pipeline`: `DataCollectionPlanner` resolves target labels + question phrasing + agent guidance from the shared registry instead of hardcoded constants, and tags every produced `Suggestion` with `meta.targetField` so the HUD can mark fields `asked`.

## Impact

- **Shared** (`packages/shared`): new `data-collection-targets.ts` module + zod schema; new feature-flag key `data_collection_hud` in `FEATURE_FLAG_DEFAULTS`; new realtime event type `dataCollectionUpdated` in `realtime.ts`. No DB changes.
- **Agents** (`packages/agents`): `DataCollectionPlanner` reads question phrasing + agent guidance from the shared registry; output adds the `targetField` key so the worker can pass it through.
- **API** (`apps/api`): new route `GET /conversations/:id/data-collection`; gated by `requireFeature('data_collection_hud')`. `routes/blogger-profiles.ts` and the staleness helper are reused verbatim. `realtime/` gets the new event emitter.
- **Workers** (`apps/workers`): `agent-run.ts` passes the planner-supplied `target_field` into the created `Suggestion.meta.targetField` so the HUD can read it (no schema migration — `Suggestion.meta` is already `Json`). `profile-extract.ts` and the suggestion-create path emit `dataCollectionUpdated` through the existing worker `publishRealtime` bridge.
- **Web** (`apps/web`): new right-panel component inside `features/inbox/` consuming the endpoint + WS event; nav unchanged.
- **Feature flag**: `data_collection_hud` default OFF; the endpoint returns 404 and the WS subscription is a no-op when off. Rollout per environment via the existing admin flag UI.
- **CLAUDE.md / DESIGN.md**: short note in CLAUDE.md "Где что лежит" pointing at `packages/shared/src/data-collection-targets.ts`; one line in DESIGN.md noting the HUD endpoint.
