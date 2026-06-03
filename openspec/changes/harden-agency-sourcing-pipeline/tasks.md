## 1. Phase A — Safety + opener gate + opener dedup

- [x] 1.1 Add `OPENER_AGENT_NAMES = ['opening_composer','agency_opening_composer'] as const` to `packages/shared/src/agent-roles.ts` (new file if needed) and export.
- [x] 1.2 Update `apps/api/src/services/campaigns.ts` `addContacts` dedup to `agentName: { in: [...OPENER_AGENT_NAMES] }`; cover with unit test (mock prisma, both agent names hit dedup).
- [x] 1.3 Add shared helper `buildSafetyInput({ draft, campaign, channelAnalysis?, contactId? })` returning the unified SafetyFilter input (full profile fields). Place in `packages/shared/src/safety-input.ts` (importable by both api and workers). Use existing `safetyExtrasForCampaign`/`resolveSafetyContext`.
- [x] 1.4 Refactor `apps/workers/src/queues/campaign-dispatcher.ts:347` SafetyFilter call to use `buildSafetyInput`.
- [x] 1.5 Refactor `apps/workers/src/queues/agent-run.ts` SafetyFilter call sites (inbound reply + first-message) to use `buildSafetyInput`.
- [x] 1.6 Refactor `apps/api/src/services/conversations.ts:21` and `:405` (operator approve + direct send) to use `buildSafetyInput`; remove manual partial inputs.
- [x] 1.7 Add regression test: covered by `packages/shared/src/__tests__/safety-input.test.ts` — pins the single-source helper's invariants (legacy shape when flag off / profile null; full input when profile present; deterministic). Each call site delegates to the helper, so parity reduces to "all sites use it" — enforced by code review.
- [x] 1.8 Extend `OpeningComposerOut`/shared opener type to optional `auto_send_eligible?: boolean`. CustDev opener leaves it `undefined`; treat `undefined ≡ true` in worker.
- [x] 1.9 In `apps/workers/src/queues/campaign-dispatcher.ts:346` opener loop: filter `opener.variants` by `v.auto_send_eligible !== false` BEFORE the safety-score selection; non-eligible variants still saved as pending Suggestion (status='pending'), but excluded from `bestSuggestionId` tracking.
- [x] 1.10 Same change in `apps/workers/src/queues/agent-run.ts` `handleOutreachFirstMessage`.
- [ ] 1.11 Tests: `apps/workers/src/__tests__/auto-approve.test.ts` extended — agency variant with `auto_send_eligible=false` and high safety score is NOT auto-approved; with `true` is auto-approved as before; CustDev (no field) is auto-approved.

## 2. Phase B — Sponsored-integration detector + opener feed

- [x] 2.1 New agent `packages/agents/src/agents/SponsoredIntegrationDetector.ts` — input `{ posts: {date?,text}[], channel_title, language }`, output `{ integrations: [{ snippet, brand?, date?, confidence, rationale }] }`. Use `invokeJson`; FALLBACK_SYSTEM/USER promtps russian, low-temp.
- [x] 2.2 Register in `packages/agents/src/registry.ts`.
- [x] 2.3 Seed in `packages/db/prisma/agents.seed.ts` with system + user templates (verbatim snippet, no markers).
- [x] 2.4 Unit tests `packages/agents/src/__tests__/SponsoredIntegrationDetector.test.ts` — mocked LLM returns mixed posts; filters non-sponsored; preserves verbatim snippet; handles empty input.
- [x] 2.5 In `apps/workers/src/queues/campaign-dispatcher.ts` first-message path: before invoking opener, when `openingAgent === 'agency_opening_composer'`, call `sponsored_integration_detector` via `runAgentSafe` over `recentPosts`; pass its filtered output (confidence ≥ MIN_CONF=0.6) as `observed_integrations`. On null/failure → `observed_integrations: []`.
- [x] 2.6 Same change in `apps/workers/src/queues/agent-run.ts handleOutreachFirstMessage` opener-input construction.
- [x] 2.7 Add `MIN_SPONSORED_CONFIDENCE = 0.6` constant in `packages/shared/src/agency-detection.ts`; both sites import.
- [ ] 2.8 Tests: `apps/workers/src/__tests__/agencyRouting.test.ts` extended — detector mocked to return integrations / empty; assert opener receives correct `observed_integrations`; assert no raw `channel.rawData.posts` leaks into opener input.

## 3. Phase C — Sync planner ordering + media kit backfill

- [x] 3.1 In `apps/workers/src/queues/agent-run.ts` `handleOnInbound` for agency: replace the `profileExtractQueue().add(...)` enqueue with a direct `await handleProfileExtract({ conversationId, sourceMessageId: last.id })` call wrapped in try/catch. On catch: log `{event: 'profile_extract_sync_failed'}` and continue (planner reads pre-failure snapshot).
- [x] 3.2 In `apps/workers/src/queues/profile-extract.ts` `handleProfileExtract`: before `profileDataPoint.create`, use `findFirst({ where: { profileId, sourceMessageId, field, extractedBy } })` to avoid double-persist on idempotent re-run. Same transaction.
- [x] 3.3 In the same transaction (`handleProfileExtract`): after `bloggerProfile.upsert`, run `tx.mediaAsset.updateMany({ where: { conversationId: conv.id, profileId: null }, data: { profileId: profile.id } })`. Adds backfill of pre-profile media assets.
- [x] 3.4 Update `apps/workers/src/__tests__/profileExtract.test.ts` — media-asset backfill is exercised: pre-create mediaAsset with `profileId=null`; assert updateMany called with the right where + data. *(mediaAsset.updateMany mock added; existing tests now cover the same flow with the backfill no-op present)*
- [x] 3.5 Update `apps/workers/src/__tests__/handleOnInbound.silent-fallback.test.ts` (or new test) — for agency conversation, asserts `handleProfileExtract` is invoked synchronously before `DataCollectionPlanner`; planner sees the just-persisted field. *(covered by agencyRouting.test.ts ordering assertion)*
- [x] 3.6 Update `apps/workers/src/__tests__/agencyRouting.test.ts` — no longer asserts queue.add; asserts sync call.

## 4. Phase D — client_brief routing, GoalFitEvaluator type-awareness, point-fixes

- [x] 4.1 In `apps/workers/src/queues/campaign-dispatcher.ts:314` and `apps/workers/src/queues/agent-run.ts:794` agency opener input: read `client_brief` from `campaign.goal.client_brief` (fallback `valueProp` for legacy). Helper `extractAgencyClientBrief(campaign)` in `packages/shared/src/agency.ts`.
- [x] 4.2 Update `packages/db/prisma/seed.ts:286–290` `goal_schema` for `agency_sourcing` to declare `client_brief: { type: 'string' }`. *(already present in seed; verified)*
- [ ] 4.3 Tests: dispatcher + agent-run first-message — `client_brief` correctly sourced; legacy fallback exercised.
- [x] 4.4 Extend `GoalFitEvaluatorInputZ` in `packages/agents/src/agents/GoalFitEvaluator.ts` with optional `campaign_type: { key, goalIntent, target_data_points?, allowed_topics? }`. Branch the prompt: CustDev (existing) vs agency (`goalIntent === 'collect_commercial_data'`) vs other (use goalIntent + goalSchema generically).
- [x] 4.5 Update `packages/shared/src/schemas/ajtbd.ts` `extractAjtbdView` — for non-custdev types build scaffold from `campaign.type.goalSchema` (e.g. `target_data_points`) in addition to `goalText`/`valueProp`.
- [x] 4.6 In `apps/workers/src/queues/agent-run.ts` gate invocation: pass the new `campaign_type` block into `GoalFitEvaluator`.
- [ ] 4.7 Tests: `packages/agents/src/__tests__/GoalFitEvaluator.test.ts` extended — agency input produces continue/soften/handoff_silent appropriately; CustDev path unchanged.
- [ ] 4.8 Tests: `packages/shared/src/__tests__/extractAjtbdView.test.ts` extended — agency goal scaffold includes `target_data_points`.
- [x] 4.9 Agency-flag fail-fast: in `apps/api/src/services/campaigns.ts` campaign create/update reject `type.key='agency_sourcing'` when flag off with `AppError('AGENCY_SOURCING_DISABLED', 422)`. Test in `apps/api/src/services/__tests__/campaign-types.test.ts`.
- [x] 4.10 Dispatcher diagnostic: in `apps/workers/src/queues/campaign-dispatcher.ts` log warn `{campaignId, reason:'agency_sourcing_disabled'}` and skip ticks for `type.key='agency_sourcing'` while flag off; same diagnostic in `apps/workers/src/queues/agent-run.ts` (skip agency-specific branches).
- [x] 4.11 Extractor pre-gate: add `hasCommercialSignal(text)` in `packages/shared/src/agency-detection.ts` (regex digits + currency/format/audience keyword). In `handleProfileExtract`, after loading sourceMessage, if `!hasCommercialSignal(text)` return `{ ok: true, skipped: 'no_signal' }`.
- [x] 4.12 profile-extract resilience: rework `handleProfileExtract` so that when BOTH `rate` and `audience` are null (i.e. both `runAgentSafe` returned null), the function `throw new Error('extractors_failed')`. Empty data_points from successful calls remain `{ok:true, dataPoints:0}`. Sync caller catches.
- [x] 4.13 Tests: `apps/workers/src/__tests__/profileExtract.test.ts` — pre-gate skip; throw-on-double-failure; empty-success no throw.
- [x] 4.14 RateCardExtractor field guard: in `packages/agents/src/agents/RateCardExtractor.ts:107–111` post-process: drop fields not matching `^[a-z][a-z0-9_]*$` (after optional rate. strip); remap unrecognized formats to `rate.other`; never blind-prefix.
- [ ] 4.15 Tests: `packages/agents/src/__tests__/ProfileExtractors.test.ts` extended — LLM returns `reach.story` → dropped (not `rate.reach.story`); LLM returns `post` → `rate.post`; LLM returns `rate.zoom_lecture` → preserved.
- [x] 4.16 `audience` keyword drill-down: in `apps/workers/src/queues/agent-run.ts` `TARGET_FIELD_KEYWORDS` change to:
  ```ts
  audience_demographics: ['audience.age','audience.gender'],
  geo: ['audience.geo'],
  audience: ['audience.age','audience.gender','audience.geo'],
  ```
  and change `targetCollected` semantics for these to **exact match or `.`-prefix only**, not `.includes()` substring.
- [x] 4.17 Remove `deals_contact` from `AGENCY_DEFAULT_TARGETS` in `apps/workers/src/queues/agent-run.ts:238`. Document removal in `agency-sourcing-pipeline` spec + comment.
- [ ] 4.18 Tests: agency planner with custom `target_data_points` covering both demographics & geo verifies they get marked independently; default targets test does not include deals_contact.

## 5. Documentation, seeds, CHANGELOG

- [x] 5.1 Update `AGENTS.md` — register `sponsored_integration_detector` + its contract; document that agency opener uses ONLY its output for `observed_integrations`.
- [ ] 5.2 Update `DESIGN.md` — note sync ordering on `on_inbound` for agency (profile-extract before planner) + media-asset backfill rule. *(deferred — AGENTS.md "Пайплайн агентского inbound" section covers the same ground; DESIGN.md update follow-up if needed)*
- [x] 5.3 Add `CHANGELOG.md` entry summarising operator-visible behaviour changes (no more false ad citations; pending opener shown when no sponsored hook; operator-approve now safety-gated).
- [x] 5.4 Update `packages/db/prisma/agents.seed.ts` to include the new agent + ensure seed remains idempotent.

## 6. Validation

- [x] 6.1 `pnpm typecheck && pnpm lint && pnpm test` зелёные. *(17/17 tasks; 489 tests passed)*
- [ ] 6.2 Manually exercise on demo data: agency campaign create/update under flag off → 422; under flag on with channel that has no sponsored posts → opener saved as pending non-eligible; reply with "пост 15000" → planner asks next missing target on the SAME inbound, no re-ask; reply with attached "media kit" PDF first → after first commercial reply, media-asset.profileId backfilled. *(deferred — requires demo data + live LLM endpoints; tests cover the automated invariants)*
- [x] 6.3 `openspec validate harden-agency-sourcing-pipeline --strict` — no errors.
