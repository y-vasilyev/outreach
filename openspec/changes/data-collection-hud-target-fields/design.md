## Context

The pieces are already in the codebase, just not joined:

- `apps/workers/src/queues/agent-run.ts` already resolves `target_data_points` per campaign (from `campaign.goal.target_data_points` or the agency default), computes the collected subset from `BloggerProfile.dataPoints[].field` via an exact-or-dotted keyword map, and feeds both into `DataCollectionPlanner`.
- `packages/shared/src/profile-staleness.ts` already provides `computeProfileFreshness(dataPoints)` returning `{ rateCards, audience, topics, ... }` with `{ stale, ageDays }`.
- `DataCollectionPlanner` has a hardcoded `QUESTION_TEMPLATES` and the same target keys in three places (planner, worker, gate prompt) with no shared module.
- `Suggestion.meta` is already `Json` on the DB side and is free for the planner to tag.

What's missing is one shared registry that names + describes each target, plus one read endpoint + one WS event + one panel that joins it all. The goal of Phase 1 is to deliver that join without touching schema or write paths.

Constraints:
- **No DB migration.** `BloggerProfile` / `ProfileDataPoint` stay authoritative.
- **No regression.** When the flag is OFF behavior is byte-identical to today.
- **Reuse the existing freshness helper.** Don't re-implement TTL classification.
- **Single source of truth for target metadata.** Planner, HUD, and gate prompt all read the same labels and descriptions.

## Goals / Non-Goals

**Goals:**

- One typed registry shared by planner + worker + HUD + (later) gate.
- A single endpoint that returns the per-target HUD state in one round trip.
- Real-time updates so the operator never sees a stale HUD.
- The flag flips the entire stack cleanly; OFF state matches today.

**Non-Goals:**

- No replacement of `BloggerProfile` / `ProfileDataPoint`. (Phase 3.)
- No admin-edited fields. (Phase 2.)
- No catalog page, snapshots, or merge. (Phase 4.)
- No new `Suggestion` columns or `target_data_points` schema validation tightening — `Suggestion.meta.targetField` is documented but not enforced as a foreign key; the registry already validates known keys.

## Decisions

### D1. Registry shape — keyed TS module, not a DB table

The registry lives in `packages/shared/src/data-collection-targets.ts`:

```ts
export interface DataCollectionTarget {
  key: string;                              // 'rate_card'
  label: string;                            // 'Прайс по форматам'
  description_for_operator: string;         // for HUD + composer pre-fill
  description_for_agent: string;            // for planner system prompt
  question_template: string;                // deterministic fallback question
  freshness_section: 'rateCards' | 'audience' | 'reach' | 'avgViews' |
                     'topics' | 'languages' | 'formats';
  profile_data_point_keys: string[];        // exact-or-dotted match roots (today's TARGET_FIELD_KEYWORDS)
  manual_only?: boolean;                    // no automated extractor (e.g. deals_contact)
}

export const DATA_COLLECTION_TARGETS: Record<string, DataCollectionTarget>;
```

Keyed by string (the existing target key). Validation: zod schema rejects unknown registry entries at load. The worker's existing `TARGET_FIELD_KEYWORDS`, `AGENCY_DEFAULT_TARGETS`, and the planner's `QUESTION_TEMPLATES` all become thin re-exports/helpers over this registry's slices, so there's exactly one place to edit a label or a question. Field matching uses one helper, `profileFieldMatchesTarget(field, target)`: a `ProfileDataPoint.field` satisfies a registry root when it is exactly equal to the root or is a dotted sub-key of it (`rate` matches `rate.post`; `audience.geo` matches `audience.geo.ru`).

Alternative considered: store as JSON on `campaign_type`. Rejected for v1 — that's exactly what Phase 2 introduces. Putting it in shared TS now ships in one PR, with a clean migration path: Phase 2 reads the same shape from `entity_field` and the registry becomes a fallback for built-in entries.

### D2. HUD endpoint is read-only, derived

`GET /conversations/:id/data-collection` (gated by `requireFeature('data_collection_hud')`):

1. Loads the conversation + its `campaign` + `campaign.type.key`.
2. Resolves the per-campaign HUD target list from `campaign.goal.target_data_points ?? agency_default_targets`, intersected with the registry. Unknown keys are dropped + warned (logged, not surfaced). HUD targets include `manual_only` entries when explicitly requested by the campaign; planner targets are resolved by a separate helper that filters them out.
3. Loads the linked channel's `BloggerProfile.dataPoints` (the field+capturedAt+value+sourceMessageId).
4. Loads the conversation's `Suggestion` rows whose `meta.targetField` is one of the targets (latest per target).
5. For each target, filters data points through `profileFieldMatchesTarget(...)`, then calls `computeProfileFreshness(targetDataPoints)` from the existing helper and reads the target's `freshness_section`. This keeps `geo` and `audience_demographics` independent even though both map to the broader `audience` freshness section.
6. For each target builds:
   - `current` = the newest target-matching data point that contributes to the target's `freshness_section` according to the same usability checks as `computeProfileFreshness`; carry `value`, `capturedAt`, `sourceMessageId`, `sourceField`.
   - `state`:
     - `answered` if `current` and target-local `freshness.stale = false`.
     - `stale` if `current` and target-local `freshness.stale = true`.
     - `asked` if no current and a `Suggestion` with this `targetField` was created in this conversation.
     - `missing` otherwise.
   - `freshness` = the target-local section's `{ stale, ageDays }` from the helper (omitted when no current).
   - `lastAskedAt` = max `Suggestion.createdAt` for this target's suggestions.

No write path, no caching layer in v1 — the join is cheap (one channel join + one conversation-scoped suggestion query) and the WS event keeps it warm.

Alternative considered: denormalize state into a new table. Rejected — re-computing on read is fine for inbox traffic and avoids state divergence.

### D3. `Suggestion.meta.targetField` — documented contract, no schema change

`Suggestion.meta` is already `Json`. The planner output gets a new optional `target_field: string` that the worker copies into `Suggestion.meta.targetField` when creating the suggestion. The HUD reads the persisted camelCase key. We add a small helper `getSuggestionTargetField(suggestion)` in `packages/shared` so callers don't have to inline `unknown`-cast access.

No FK, no enum on the DB side — the registry validates known keys at the read boundary, and an unknown `targetField` is simply ignored by the HUD (logged at debug).

Alternative considered: a new `Suggestion.targetField` column. Rejected for Phase 1 — `meta` is already there, the contract is documented in the registry, and adding a column for an optional string is a migration we can skip.

### D4. `dataCollectionUpdated` WS event — patch in place

A new event on the existing realtime channel: `{ conversationId, targetKey, state, current?, freshness?, lastAskedAt? }`. Emitted from:

- The `ProfileDataPoint` write path (today `apps/workers/src/queues/profile-extract.ts`; if API-side writes are added later, they use the same emitter) — emit *after* the transaction commits. One event per affected target — typically 1, sometimes more when one extractor write covers multiple targets.
- The `Suggestion` create path in `apps/workers/src/queues/agent-run.ts` when `meta.targetField` is set.

Subscribers in the conversation's existing room receive it. The web panel patches its local state; no re-fetch of the full HUD.

Reuse the existing realtime infra; the event is a new type but the transport is unchanged.

### D5. Planner consumes the registry, output gains `target_field`

`DataCollectionPlanner`:

- Removes local `QUESTION_TEMPLATES` constant; reads `question_template` and `description_for_agent` from the registry.
- Receives `resolveEffectivePlannerTargets(...)`, which excludes `manual_only` targets. `manual_only` entries can still appear in the HUD via `resolveEffectiveHudTargets(...)`, but they do not block `goal_satisfied`.
- The prompt's `target_data_points` variable becomes a richer list — `{ key, description_for_agent }` per item — so the LLM picks by description, not by an opaque key.
- Output schema adds `target_field?: string` (the registry key it picked). The deterministic override layer (already present — picks the first missing if the LLM picks a collected/wrong field) sets `target_field` to the chosen key so the worker can tag the suggestion without re-parsing.

The agent's existing zod schema is extended, not broken — the new field is optional. The worker tolerates missing values (legacy behavior preserved).

### D6. Feature flag — single switch

`data_collection_hud` (default off). When OFF:

- HUD endpoint returns 404 (gated by `requireFeature`).
- The WS emitter early-returns.
- The web panel hides itself (the existing inbox sidebar is unchanged).
- The planner *still uses the new registry-backed prompts* — the registry change is behavior-preserving (same target keys, same questions wrapped in a TS module), so it doesn't need the flag.

This isolates the operator-facing surface behind the flag while letting us ship the registry refactor unconditionally.

## Risks / Trade-offs

- [HUD shows a target the campaign declares but the registry doesn't know] → Mitigation: at read time, drop unknown keys + log a warning. Operators never see the HUD inconsistency, but ops sees the warning and adds the entry in a follow-up PR.
- [Planner's prompt size grows because we now pass descriptions] → Mitigation: per-target description is ~15 words; the prompt grows by ~300 tokens at most. Cost impact negligible on Haiku-tier.
- [Stale HUD on missed WS event] → Mitigation: the panel falls back to a 30s poll while visible (cheap — the endpoint is read-only). The WS event is best-effort UX; correctness lives in the endpoint.
- [`Suggestion.meta.targetField` drifts from registry as keys evolve] → Mitigation: the HUD treats an unknown `targetField` as "not pinned to a known target" and ignores it. A registry rename is therefore safe; old suggestions just stop colouring the HUD.
- [Flag-off path silently breaks if a developer assumes the new event] → Mitigation: the realtime event type is declared in `packages/shared/src/realtime.ts` with an explicit comment that delivery is flag-gated; consumers must tolerate gaps.

## Migration Plan

1. Ship the shared registry + planner refactor + worker `Suggestion.meta.targetField` write — flag OFF. No operator-visible change.
2. Ship the endpoint + WS emitter + web panel — flag OFF, behind `requireFeature`. The flag-off state matches stage 1 exactly.
3. Flip `data_collection_hud` ON in staging. Verify the panel matches reality by spot-checking 3 active agency conversations against the existing blogger profile view.
4. Flip ON in prod. The flag is the only knob; no other follow-up.

**Rollback:** flip the flag OFF. The registry refactor stays in place (it's behavior-preserving). If a regression is registry-attributable, revert just the planner change — the worker passes `targetField` only when present so a flag-off + planner-revert leaves the system identical to today.

## Open Questions

- **OQ1**: `deals_contact` has no automated extractor; should it be in the HUD as `manual_only` from day one or hidden until Phase 2? Current decision: show it with a "manual" badge so operators see the gap explicitly. Confirm with ops.
- **OQ2**: When a target is `stale` but the conversation hasn't re-asked, should the HUD surface a "re-ask" action that pre-fills the composer? Sketch says yes, low cost, but it crosses into planner territory. Defer to the panel design review.
- **OQ3**: Phase 2 (`entity-types-shadow-metadata`) will move the registry to DB-backed metadata. The shape designed here is intentionally close to `entity_field` (`description_for_operator`/`agent`, `freshness_section`) — confirm we keep the same field names so Phase 2 is a clean adapter swap.
