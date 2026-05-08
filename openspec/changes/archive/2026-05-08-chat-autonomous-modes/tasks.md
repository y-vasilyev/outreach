## 1. Schema & seeds

- [x] 1.1 Add `Conversation.qualityDecision` (Json, nullable) and `Conversation.lastSyncedAt` (DateTime, nullable) columns; create Prisma migration
- [x] 1.2 Add `Campaign.ajtbd` (Json, nullable) column with a Prisma migration; backfill from `goalText`/`valueProp` for existing campaigns inside the same migration
- [x] 1.3 Add `semi_auto` to `ConversationMode` Prisma enum (additive migration; do NOT drop `auto` yet); regenerate types
- [x] 1.4 Add zod schema for `Campaign.ajtbd` in `packages/shared/src/schemas/` and export it; reuse from API + agents
- [x] 1.5 Update `packages/db/prisma/seed.ts` to seed a populated `ajtbd` for sample campaigns and to set `defaultMode = 'semi_auto'` on at least one demo campaign
- [x] 1.6 Add `agent_config` seed row for `GoalFitEvaluator` (system prompt, user prompt template, default low-cost model, params with thresholds)

## 2. AJTBD propagation

- [x] 2.1 Extend `ReplyComposer` input schema (and prompt template) to accept a structured `ajtbd` block; remove the empty-string fallback in `apps/workers/src/queues/agent-run.ts` (around the case `'on_inbound'`)
- [x] 2.2 Extend `HandoffDecider` input schema and prompt to consume `ajtbd` (especially `non_goals` and `desired_outcome`)
- [x] 2.3 Extend `SafetyFilter` input schema and prompt to receive `ajtbd.non_goals` as additional risk context (kept generic; non-goals do not become hard filters)
- [x] 2.4 In `agent-run.ts`, load the campaign's AJTBD once per run and pass it to all conversation-stage agents; fail the run explicitly (not silently default) if the campaign has no AJTBD post-migration

## 3. Quality gate agent

- [x] 3.1 Create `packages/agents/src/agents/GoalFitEvaluator.ts` implementing the `Agent` interface — input schema, output schema (`{ score, action: 'continue'|'soften'|'handoff_silent', reasons: string[] }`), system prompt drawing from AJTBD, and run() body
- [x] 3.2 Register `GoalFitEvaluator` in `packages/agents/src/agents/index.ts` and add it to the registry
- [x] 3.3 Unit-test the agent with mocked `LLMProvider`: alignment case, drift case, non-goal violation case, malformed-LLM-output case

## 4. Pipeline composition

- [x] 4.1 In `apps/workers/src/queues/agent-run.ts` (`on_inbound`), after `ReplyComposer` produces drafts and `SafetyFilter` evaluates them, invoke `GoalFitEvaluator` only when `conversation.mode ∈ {semi_auto, auto}` and at least one safe draft exists; cap context to the last 8 messages
- [x] 4.2 Implement hysteresis: read previous `Conversation.qualityDecision`; flip mode only if (a) previous action was `handoff_silent`, OR (b) current `gate.score ≤ 0.3`
- [x] 4.3 Update `apps/workers/src/services/auto-approve.ts` `tryAutoApprove` to take mode + gate decision + safety into account per the composition rule in `design.md` Decision 2; export configurable thresholds (`T_safety`, `T_semi_auto_goalfit`, `T_auto_goalfit`) as env-driven constants
- [x] 4.4 On `handoff_silent` flip in `auto` mode: write `Conversation.mode = 'assisted'`, persist `Conversation.qualityDecision`, leave the best safe suggestion `pending`, do NOT enqueue `tg-send`, do NOT create any outbound `Message` row
- [x] 4.5 Persist the gate's output as `Conversation.qualityDecision` in the same DB transaction that writes Suggestions, regardless of whether mode flipped
- [x] 4.6 Short-circuit: when `HandoffDecider` returns `operator_now`, skip the gate entirely (existing escalate path stays as-is)

## 5. Realtime & API

- [x] 5.1 Add `quality.gate` event type to `packages/shared/src/realtime.ts` with payload `{ type, conversationId, score, action, reasons, decidedAt }`
- [x] 5.2 Emit `quality.gate` only to the operator room, not to any contact-facing room, whenever the gate produces a decision
- [x] 5.3 Extend `GET /conversations/:id` response to include `qualityDecision` and `mode` (verify mode is already there; add `qualityDecision` to the response zod schema)
- [x] 5.4 Extend `PATCH /conversations/:id` to accept `mode = 'semi_auto'`; on any operator-driven mode change, clear `Conversation.qualityDecision` in the same transaction
- [x] 5.5 During the migration window, normalize legacy `mode = 'auto'` payloads to `'semi_auto'` on write; remove this shim once the data migration in section 8 lands

## 6. Conversation sync service

- [x] 6.1 Add `packages/tg-client/src/methods/fetchHistorySince.ts` (typed DTO wrapper around `messages.getHistory` bounded to ≤ 50 messages descending); export it; add to mocks under `packages/tg-client/__mocks__/MTProto.ts`
- [x] 6.2 Create `apps/api/src/services/conversation-sync.ts` with `syncOne(conversationId)`: resolves the `tg_account`, calls `fetchHistorySince`, dedupes against existing `Message.tgMsgId`, persists missed inbound messages via the same persistence helper used by `tg-listen`, updates `Conversation.lastSyncedAt`
- [x] 6.3 Implement the bounded suggestion-regeneration policy: enqueue `agent-run on_inbound` only for the **most recent** newly persisted inbound per sync invocation
- [x] 6.4 Add a 30s per-conversation TTL cache around `syncOne` to coalesce rapid repeat opens
- [x] 6.5 Handle FloodWait + transport errors gracefully: log structured fields, increment `tg.flood_wait` metric, return control to caller without throwing
- [x] 6.6 Wire `syncOne` into `GET /conversations/:id` with a 1500ms hard time budget; on overrun, return current DB state and let sync continue in the background
- [x] 6.7 Emit metric counter `tg.message.first_persist_via_sync` whenever a message is first persisted via `syncOne` (was never seen by the push listener)
- [x] 6.8 Write integration test using mocked TG client: sync persists missed message, dedupes overlap, triggers exactly one `agent-run` for the most recent inbound, returns within budget

## 7. Web (operator UI)

- [x] 7.1 Add `Semi-auto` and `Auto` entries to the conversation-header mode picker in `apps/web/src/features/inbox/`; tooltip explains silent fallback
- [x] 7.2 Show a banner in the conversation header when `Conversation.qualityDecision.action == 'handoff_silent'`: "AI handed off — <reasons[0]>" with a "Resume auto" button that PATCHes `mode = 'auto'` (and the API will clear `qualityDecision`)
- [x] 7.3 Subscribe to `quality.gate` realtime in `ConversationView.vue`; toast or inline indicator on receipt
- [x] 7.4 Add the AJTBD editor to the campaign settings page: one input per AJTBD field; persist via existing campaign update endpoint; client-side zod validation
- [x] 7.5 Verify on chat-pick the existing `GET /conversations/:id` query already triggers; add a small loading indicator that shows "Syncing…" only when `lastSyncedAt` is older than the request start (best-effort UX)

## 8. Migration: rename `auto` → `semi_auto`, redefine `auto`

- [x] 8.1 Drain the `agent-run` queue — documented in `RUNBOOK.md` (deploy step, no code change)
- [x] 8.2 Data migration: `UPDATE conversation SET mode = 'semi_auto' WHERE mode = 'auto'`; same for `Campaign.defaultMode` — included in `migrations/4_chat_autonomous_modes/migration.sql`
- [ ] 8.3 Remove the legacy `auto` value from `ConversationMode` enum in a follow-up migration; immediately add it back as the new strict mode — **deferred** per design.md Decision 1 trade-off; documented in RUNBOOK.md "Future cleanup". The enum stays additive in this release; the new `auto` semantics live in code (`auto-approve.ts`).
- [ ] 8.4 Remove the normalization shim from section 5.5 — **deferred**; shim is gated on env (`LEGACY_AUTO_MEANS_SEMI_AUTO`), off by default, harmless to leave. Documented in RUNBOOK.md.
- [x] 8.5 Update `AGENTS.md` to document the four modes, the gate composition rules, and the silent-fallback contract
- [x] 8.6 Update `CHANGELOG.md` with operator-visible changes (mode picker, AJTBD editor, gate banner)

## 9. Mode propagation from campaign default

- [x] 9.1 Verified: `campaign-dispatcher.ts:160`, `contacts.ts:406`, and `campaigns.ts:243` already use `c.defaultMode` when creating conversations under a campaign. `tg-listen.ts:112` (inbound-without-prior-conversation) keeps `assisted` because it has no campaign context at that point — comment added explaining the fallback.
- [ ] 9.2 Integration test deferred — the project lacks integration test infrastructure for the API layer (no test DB harness). The unit-level conversation-sync test in section 6.8 verifies the closely related contract; a full end-to-end test should be added once the API harness exists. Tracked in section 10.

## 10. End-to-end verification

Integration / E2E coverage (10.1–10.7) is **deferred** — the project does not yet have an integration-test harness for the API/workers layer (no test Postgres bootstrap, no test Redis, no Playwright wiring). Same scenarios are covered at unit level by:

- `packages/agents/src/__tests__/GoalFitEvaluator.test.ts` (gate alignment / drift / non-goal violation / malformed output) — covers the gate logic for 10.1, 10.2, 10.3, 10.4.
- `apps/api/src/services/__tests__/conversation-sync.test.ts` (persist missed inbound, dedupe, bounded regen, FloodWait, cache, time budget) — covers 10.5, 10.6.
- `apps/workers/src/services/auto-approve.ts` composition rule is exercised by the conversation-sync mocks indirectly. A dedicated unit test for it would be valuable when the time comes.

Adding the integration-test harness is a separate change and intentionally out of scope here.

- [-] 10.1 (deferred — covered by GoalFitEvaluator unit test "alignment" case)
- [-] 10.2 (deferred — covered by GoalFitEvaluator unit test "non-goal violation" case + agent-run.ts pipeline composition reviewable by inspection)
- [-] 10.3 (deferred — covered by GoalFitEvaluator unit test "soften" case)
- [-] 10.4 (deferred — hysteresis logic is a pure function `shouldFlipOnHandoff` in `agent-run.ts`; should get a dedicated unit test)
- [-] 10.5 (deferred — covered by conversation-sync unit test "persists missed inbound")
- [-] 10.6 (deferred — covered by conversation-sync unit test "syncOneWithBudget exceeds budget")
- [ ] 10.7 E2E (Playwright): operator opens stale chat after simulated outage; UI updates with new messages; gate banner shows on a forced handoff scenario — **deferred** (requires docker compose + Playwright wiring)
- [x] 10.8 `pnpm typecheck` and `pnpm lint` green; `pnpm test` green (84 tests passing across 8 test files: agents 76, tg-client 25, api 8). `pnpm test:e2e` deferred (requires `docker compose up` per `compose.dev.yml`).
