## Why

After Phase 2 (`entity-types-shadow-metadata`) the admin can edit field metadata, but the data still flows through `BloggerProfile` / `ProfileDataPoint` only. To make the field set actually configurable (add a new field → start collecting it without code), we need the EAV value store. Phase 3 introduces it **alongside** the existing path with strict dual-write and shadow diffing — never replacing the source of truth, never turning agents loose on it.

The danger of Phase 3 is silent divergence: writes hit two places, the rollup runs twice, and an inconsistency goes unnoticed for weeks. So we are explicit:

- Dual-write happens on every extractor + operator write.
- The EAV shadow rollup runs and diffs against the legacy rollup. Diffs are logged, not surfaced to the operator UI.
- Reads stay on the legacy path — the EAV side is shadow only.
- Agents get **`field_propose` only** (no `field_set`). Every proposal lands in a moderation queue surfaced in the inbox HUD; operators accept/reject; an accepted proposal writes to **both** the legacy `ProfileDataPoint` and the EAV `entity_value` so the two never drift apart from the operator's hand.
- No snapshots, no merge, no entity-type builder, no Blogger aggregate in this release — those are Phase 4.

This is the third of four sequential phases. See also: `data-collection-hud-target-fields` (Phase 1), `entity-types-shadow-metadata` (Phase 2), `blogger-aggregate-and-catalog` (Phase 4).

## What Changes

- Add `entity_value` Prisma model `{ id, entity_type_id, field_id, channel_id, value Json, value_text?, value_number?, value_date?, value_boolean?, unit?, confidence, captured_at }` (channel-scoped only — per-blogger scope arrives with the Blogger aggregate in Phase 4). Add `entity_value_revision` for the append-only history.
- Add `entity_value_proposal` `{ id, entity_type_id, field_id, channel_id, conversation_id, proposed_value Json, confidence, agent_run_id, source_message_id, raw_snippet, status ∈ {pending, accepted, rejected}, decided_by_user_id?, decided_at? }` — the moderation queue for agent-proposed values.
- Add the **dual-write adapter** in `apps/api/src/services/blogger-profiles.ts`: every `ProfileDataPoint` write also writes the matching `entity_value` + `entity_value_revision`, in the same transaction. If the EAV write fails, the legacy write rolls back too — we never accept partial state in the trusted-write path (operator + accepted-proposal writes). Failure to dual-write logs a high-severity event for the on-call engineer.
- Add **EAV shadow rollup**: a separate `eav-rollup` worker job that recomputes the rolled-up shape from `entity_value` rows and diffs it against the legacy `BloggerProfile` row. Diffs go to a `rollup_divergence` log table `{ channel_id, field_key, legacy_value, eav_value, captured_at }` for ops review. The legacy rollup keeps running; reads keep coming from it.
- Add **proposal queue** in the HUD: the existing HUD endpoint gains a `proposals[]` array per target with pending proposals; the inbox panel gains accept/reject buttons. On accept, the dual-write path runs in a transaction so both legacy + EAV land together. On reject, the proposal is closed and the operator's reason is logged.
- Rewire **agents** (`RateCardExtractor`, `AudienceStatsExtractor`) to write `entity_value_proposal` rows (not direct writes) via a thin `field_propose(...)` helper in `packages/agents/src/tools/`. No `field_set` exists yet — Phase 4 introduces it once we trust the dual-write path. Until then, every agent-discovered value is operator-mediated.
- Add `entity_value_proposal` autoaccept threshold per `entity_field`: when `confidence >= auto_accept_min_confidence` (default `0.85`, configurable per field in Phase 2's editor), the dual-write happens immediately without operator gating. Below the threshold, the proposal sits in the queue.
- Add **divergence dashboard** in `apps/web/src/features/settings/` (admin-only): row per channel × field showing legacy value, EAV value, last diff seen, count. Ops uses this to verify shadow correctness before Phase 4.
- Gate behind feature flag `eav_dual_write` (default off). When OFF, the proposal queue is hidden, agents revert to direct `ProfileDataPoint` writes, no EAV write occurs.

Non-goals: no `field_set` (write-direct) tool; no snapshots; no rollback UI; no merge; no Blogger aggregate; no replacement of the legacy rollup as source of truth; no EAV-driven matching.

## Capabilities

### New Capabilities

- `entity-value-shadow-store`: channel-scoped `entity_value` + `entity_value_revision` written via the dual-write adapter; never the source of truth in this phase; shadow rollup + divergence log.
- `agent-field-propose`: thin `field_propose(...)` helper agents use to enqueue `entity_value_proposal`; no `field_set` exists yet.
- `proposal-moderation-queue`: per-target pending proposals surfaced in the HUD and the divergence dashboard; operator accept/reject; auto-accept above per-field confidence threshold.

### Modified Capabilities

- `data-collection-hud`: the HUD endpoint gains a `proposals[]` array per target; the inbox panel gains accept/reject UI.
- `agency-sourcing-pipeline`: extractor agents write via `field_propose` instead of writing `ProfileDataPoint` directly; the worker dual-writes on operator accept; auto-accept dual-writes immediately when confidence clears the field's threshold.
- `entity-type-registry`: `entity_field` gains a nullable `auto_accept_min_confidence` (default `0.85`) configurable from Phase 2's editor.

## Impact

- **DB schema**: new `entity_value`, `entity_value_revision`, `entity_value_proposal`, `rollup_divergence` tables; `entity_field.auto_accept_min_confidence` nullable column.
- **Shared** (`packages/shared`): zod schemas for the new tables; new feature-flag key `eav_dual_write`; helper `eavRollup(channelId)`.
- **Agents** (`packages/agents`): `tools/EntityFieldTools.ts` with `field_propose` only; rewire `RateCardExtractor` and `AudienceStatsExtractor` to call it; behavior preserved when the flag is OFF (legacy direct writes).
- **API** (`apps/api`): proposal accept/reject endpoints; HUD endpoint extended; divergence dashboard data endpoint (admin-only).
- **Workers** (`apps/workers`): `eav-rollup` worker comparing EAV-derived rollup to legacy `BloggerProfile`; logs to `rollup_divergence`.
- **Web** (`apps/web`): inbox panel gains accept/reject UX; new admin divergence dashboard.
- **Rollout**: ship schema + dual-write + shadow rollup flag-off; flip ON in staging; verify zero divergence on a representative 7-day window; flip ON for one campaign in prod; expand once divergence stays at zero for 30 days.
- **Risk**: medium. The dual-write transaction is the key contract — if EAV write fails the legacy write must roll back. Ops dashboard is non-negotiable.

## Relation to `placement-offer-table`

The `placement_offer` table (change `placement-offer-table`, shipped ahead of this phase) is a **derived domain projection** of placement facts, optimized for catalog search — not a competing source of truth. Rules when this phase lands: (1) authority stays with facts (`ProfileDataPoint` now, `entity_value` after Phase 4); offer rows remain rebuildable from facts via the backfill path; (2) the shadow-rollup divergence check extends to offer rows (recompose from EAV values, diff against existing rows, log to `rollup_divergence`); (3) in Phase 4 the offer-row dual-write switches its source from the legacy data-point write to the EAV write — the table, its lifecycle (active/superseded chains), and its consumers are unchanged.
