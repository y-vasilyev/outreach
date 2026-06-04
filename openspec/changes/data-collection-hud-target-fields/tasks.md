## 1. Shared registry + feature flag

- [x] 1.1 Create `packages/shared/src/data-collection-targets.ts` exposing `DataCollectionTarget` type, `DATA_COLLECTION_TARGETS` map, zod schema, and helpers `getTarget(key)`, `resolveEffectiveHudTargets(campaign)`, `resolveEffectivePlannerTargets(campaign)` (excludes `manual_only`), `profileFieldMatchesTarget(field, target)`, `targetsForProfileField(field)`, and `getSuggestionTargetField(suggestion)`.
- [x] 1.2 Seed the registry with `rate_card`, `reach`, `audience_demographics`, `geo`, and `deals_contact` (manual_only). Reuse today's `QUESTION_TEMPLATES` Russian phrasing in `question_template`, today's `TARGET_FIELD_KEYWORDS` entries in `profile_data_point_keys[]` with exact-or-dotted-subkey matching.
- [x] 1.3 Add `data_collection_hud: false` to `FEATURE_FLAG_DEFAULTS` in `packages/shared/src/feature-flags.ts`; seed the `feature_flag` row.
- [x] 1.4 Declare the realtime event type `dataCollectionUpdated` in `packages/shared/src/realtime.ts` (no transport change).
- [x] 1.5 Re-export everything from `packages/shared/src/index.ts`.

## 2. Planner + worker rewire

- [x] 2.1 Delete local `QUESTION_TEMPLATES` in `packages/agents/src/agents/DataCollectionPlanner.ts`; resolve `question_template` and `description_for_agent` from the registry.
- [x] 2.2 Extend `dataCollectionPlannerOutputSchema` with optional `target_field: string`; populate it in `run()` deterministically (set to `nextPoint` whenever a question is emitted; omit on closing).
- [x] 2.3 Update `apps/workers/src/queues/agent-run.ts`: drop the local `AGENCY_DEFAULT_TARGETS` and `TARGET_FIELD_KEYWORDS` (derive from the registry helpers); use `resolveEffectivePlannerTargets` for planner input; pass the planner's `target_field` into the created `Suggestion.meta.targetField`.
- [x] 2.4 Update `GoalFitEvaluator` prompt assembly to read target descriptions from the registry so the gate sees the same vocabulary the planner uses (no shape change to the agent input).
- [x] 2.5 Update unit tests for the planner + worker to assert `target_field` is set and `Suggestion.meta.targetField` is persisted.

## 3. HUD endpoint + realtime emitter

- [x] 3.1 Add `apps/api/src/routes/conversations.ts` (or extend it) with `GET /conversations/:id/data-collection`; gate via `requireFeature('data_collection_hud')`.
- [x] 3.2 Implement the join: load conversation + campaign + channel + `ProfileDataPoint`s + suggestions with `meta.targetField`; classify state per the spec using target-local data-point subsets and `computeProfileFreshness(targetDataPoints)`.
- [x] 3.3 Emit `dataCollectionUpdated` from the `ProfileDataPoint` write path in `apps/workers/src/queues/profile-extract.ts` and from the `Suggestion` create path in `apps/workers/src/queues/agent-run.ts`, gated by the flag and published through the existing worker `publishRealtime` bridge.
- [x] 3.4 Unit tests (`packages/shared/src/__tests__/data-collection-targets.test.ts`): registry load validation, exact-or-dotted matching, HUD vs planner target resolution, `manual_only` exclusion, and `getSuggestionTargetField`.
- [x] 3.5 Route/service test (`apps/api/src/routes/__tests__/data-collection-hud.test.ts` or nearest existing conversation-route test location): seed a conversation with `ProfileDataPoint`s and a targeted suggestion; assert HUD classifies states correctly, including target-local audience-vs-geo freshness, and respects the flag (404 when off).

## 4. Web — inbox right panel

- [x] 4.1 Add a `DataCollectionPanel` component inside `apps/web/src/features/inbox/` that fetches the HUD endpoint when the conversation opens.
- [x] 4.2 Subscribe to `dataCollectionUpdated` events on the conversation room and patch the local state in place; fall back to a 30s poll while the panel is visible.
- [x] 4.3 Render per target: label, `description_for_operator` tooltip, state badge (`answered` / `asked` / `missing` / `stale`), current value with `sourceMessageId` link that scrolls the inbox to the source message, freshness pill with `ageDays`.
- [x] 4.4 On `missing` rows, add a "Задать вопрос" button that pre-fills the composer with the registry's `description_for_operator` (or the `question_template` as a starting point).
- [x] 4.5 When `data_collection_hud` is OFF (or the endpoint returns 404), render the existing minimal sidebar — do not crash, do not show an error.

## 5. Rollout + docs

- [x] 5.1 Verify `pnpm typecheck && pnpm lint && pnpm test` green; verify staging with the flag ON against 3 active agency conversations.
- [x] 5.2 Add CHANGELOG entry noting the new operator-visible HUD behind `data_collection_hud`.
- [x] 5.3 Add one line to `CLAUDE.md` "Где что лежит" pointing at `packages/shared/src/data-collection-targets.ts`.
- [ ] 5.4 Flip the flag ON in production once staging is clean; keep an eye on the `dataCollectionUpdated` event volume for one day.
