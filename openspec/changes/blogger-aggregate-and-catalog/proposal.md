## Why

By the end of Phase 3 (`eav-write-path-dual-write`) the EAV value store is trusted (zero divergence for 30 days), but it is still channel-scoped, the source-of-truth read path is still legacy `BloggerProfile`, there is no Blogger-as-a-person aggregate, no snapshots/rollback, no admin catalog page, and no campaign-type builder. Phase 4 finishes the picture: make EAV authoritative, introduce the Blogger aggregate so one person across Telegram + Instagram + YouTube is one row, give operators a catalog page + per-blogger card with snapshots and a versioned timeline, and ship the campaign-type builder that turns a plain-language brief into a drafted entity type + agent set.

This is the fourth and final phase of the EAV roadmap. See also: `data-collection-hud-target-fields` (Phase 1), `entity-types-shadow-metadata` (Phase 2), `eav-write-path-dual-write` (Phase 3).

## What Changes

- **BREAKING** Make EAV the source of truth. Reads switch to the EAV-derived rollup; `BloggerProfile` becomes a denormalized read-cache populated by the rollup worker (no longer authoritative). The legacy `ProfileDataPoint` write path is removed once Phase 3's dual-write has been zero-divergence for 30 days.
- Introduce **`Blogger`** aggregate `{ id, display_name, notes?, merged_into_id? }` + **`blogger_channel_link`** `{ blogger_id, channel_id, role ∈ {primary, secondary}, linked_at, unlinked_at? }`. Backfill one synthetic blogger per existing channel. Operators can merge two bloggers (one row owns N channels across platforms); merges are snapshot-protected and reversible.
- Per-field **scope**: `entity_field.scope ∈ { blogger, channel }` (default `channel`, matching today). Blogger-scope fields (e.g. payment terms, real name) live once per blogger; channel-scope fields (reach, audience, rate cards) live per linked channel. The catalog filters reach as `MAX(across linked channels)` by default with a "per channel" toggle.
- Introduce **`entity_snapshot`** + **`entity_snapshot_value`** per Blogger: atomic point-in-time copy of every current `entity_value` across the blogger and its linked channels. Snapshots get a `label` + `reason`. **Rollback** to a snapshot is append-only (new revisions mirroring the snapshot's values) so revisions stay an immutable audit log and a rollback is itself reversible.
- Introduce **`field_set`** alongside the existing Phase 3 `field_propose` (auto-mode-only, gated per-agent-config, gated globally by a `agent_field_set` flag). For agents under operator review, only `field_propose` exists; for auto-mode high-confidence extractors that have proven safe, `field_set` writes directly subject to the field's `auto_accept_min_confidence`. Tool calls go through `AgentRunner` accounting like every other agent call.
- Add **versioned timeline UI** on the blogger card: chronological list of revisions and snapshots, each with actor, source message link, run id link, and one-click rollback. The diff API (`GET /bloggers/:id/diff?from=...&to=...`) drives both the timeline drawer and any future export.
- Add **blogger catalog page** `/bloggers`: paginated list with filters (topic, language, format, reach min, freshness max days, linked-channel count, `has_field` presence); keyset pagination; per-row freshness summary. Row click → blogger card with all attributes (blogger-scope at top + per-channel tabs).
- Add **`CampaignTypeBuilder`** flow: operator describes a campaign goal in plain language; a meta-agent drafts an entity type (fields + descriptions + TTLs + dependencies + per-field auto-accept threshold), drafts each pipeline-role agent config with prompts and a per-role tool whitelist, and runs each drafted agent against test fixtures in a sandboxed in-memory entity store. On explicit save the campaign type + entity type + agent configs are persisted (versioned via `agent_config_history`).
- Introduce **field dependencies** as a usable concept: `entity_field_dependency` declares `{ field_id, depends_on_field_id, kind ∈ {requires_present, requires_value_match} }`. The planner refuses to ask a dependent field until its dependency is satisfied; the HUD marks blocked fields with the dependency chain so the operator understands why.
- Decommission the legacy direct-write `ProfileDataPoint` path after a stable rollout window.
- Gate behind feature flag `eav_authoritative` (default off). When OFF, behavior is Phase 3's dual-write with legacy reads. The catalog page, the builder, the snapshot UI, and the timeline are all hidden.

Non-goals: no replacement of the matcher's scoring inputs in this change (the matcher continues to read the rolled-up shape, which is now derived from EAV). Adding matching against arbitrary EAV fields beyond the rolled-up surface is a follow-up.

## Capabilities

### New Capabilities

- `blogger-aggregate`: a `Blogger` row + `blogger_channel_link` join; one blogger owns N channels across platforms; backfill one synthetic blogger per channel; admin merge action with snapshot-based reversibility.
- `entity-field-scope`: per-field `scope ∈ {blogger, channel}` distinguishing blogger-once-shared fields from per-channel-platform-specific fields, used by the planner, the HUD, the catalog, and the rollup.
- `entity-versioning-snapshots`: append-only revision log per `entity_value` + per-blogger `entity_snapshot` / `entity_snapshot_value` with atomic creation, diff API, and append-only rollback.
- `blogger-catalog-card-ui`: admin `/bloggers` list with filters + per-blogger card aggregating blogger-scope + per-channel fields + versioned timeline + snapshot/rollback actions + merge dialog.
- `campaign-type-builder-eav`: builder flow that drafts an entity type + agent configs + tool whitelists from a plain-language goal, sandboxed dry-runs them, and persists on explicit save.
- `agent-field-set`: `field_set` tool (write-direct) exposed only to agents whose config explicitly opts in; gated globally by a feature flag; auto-accept threshold per field still applies.
- `field-dependencies`: declarative dependencies between fields enforced by the planner + surfaced in the HUD.

### Modified Capabilities

- `blogger-commercial-profile`: source of truth shifts from `ProfileDataPoint` to `entity_value`; the legacy `BloggerProfile` becomes a read-cache populated by the EAV rollup; the response shape stays compatible.
- `data-collection-hud`: HUD reads from EAV; the right panel renders blocked fields with their dependency chain; the catalog quick-jump links live in the panel.
- `agency-sourcing-pipeline`: planner consumes EAV state directly (no more dual-source); the planner enforces field dependencies before asking.
- `campaign-type-registry`: `campaign_type.entity_type_id` becomes mandatory (after migration); the type's `agent_set` declares per-role tool whitelists resolved against the linked entity type.
- `entity-type-registry`: entity types support cloning to drafts when an enabled type needs breaking edits; additive-only edits on enabled types stay enforced; `entity_field` gains `scope` and `dependencies[]`.
- `entity-value-shadow-store` (from Phase 3): the table is renamed conceptually to `entity-value-store` and becomes authoritative; `rollup_divergence` is deprecated (kept read-only for one release).

## Impact

- **DB schema**: new `blogger`, `blogger_channel_link`, `entity_snapshot`, `entity_snapshot_value`, `entity_field_dependency` tables; `entity_field.scope`, `entity_value.subject_kind` columns; backfill of one synthetic blogger per channel; backfill of `subject_kind = "channel"` on all existing `entity_value` rows; `campaign_type.entity_type_id` becomes NOT NULL.
- **Shared** (`packages/shared`): zod schemas for the new tables; helper `bloggerFromChannel(channel)` for backfill; new feature flags `eav_authoritative`, `agent_field_set`, `campaign_type_builder_v2`.
- **Agents** (`packages/agents`): `field_set` added to `EntityFieldTools`; `CampaignTypeBuilder` meta-agent; planner reads dependencies and refuses to skip them.
- **API** (`apps/api`): `routes/bloggers.ts` (catalog + card + merge + snapshot + diff + rollback); `routes/campaign-type-builder.ts` (builder draft + save); read path through the EAV rollup; legacy `ProfileDataPoint` endpoints kept read-only for one release then removed.
- **Workers** (`apps/workers`): the EAV rollup worker becomes authoritative (writes the `blogger_profile` read-cache); `entity-snapshot` worker for atomic snapshot creation.
- **Web** (`apps/web`): new `features/bloggers/` (catalog + card + timeline + snapshots + merge); `features/campaign-type-builder/` (builder UI); the inbox HUD gains dependency-blocked rendering.
- **Migration**: 30-day green-divergence requirement from Phase 3 is the precondition. After cutover, one release window keeps the dual-write alive as a safety net (now EAV is the master, legacy is the mirror), then the legacy `ProfileDataPoint` write path is removed.
- **Risk**: high. The cutover from legacy-authoritative to EAV-authoritative is the single hardest moment in the roadmap. Mitigations: the 30-day divergence window from Phase 3, a read-mode toggle (`reads_from = legacy | eav`) that lets ops switch back in one click during the cutover window, and a snapshot of every Blogger taken automatically the moment the flag flips.
