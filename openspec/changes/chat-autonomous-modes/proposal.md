## Why

CustDev outreach today runs in `assisted` mode by default: every inbound message produces operator-facing suggestions, and a human approves each send. That doesn't scale and burns operator attention on conversations that are perfectly on-rails. We have an `auto` mode, but it's a thin auto-approve over `SafetyFilter.risk_score` — it has no notion of whether the conversation is still tracking the campaign goal, and its only fallback is to leave a `pending` suggestion and hope the operator notices.

We need two distinct levels of autonomy (semi-auto, fully auto), both anchored in the campaign's AJTBD framing, and a model-driven quality gate that hands a conversation back to the operator silently — at human pace, with no "operator is taking over" tell — when goal-fit erodes. Separately, when workers were offline, the inbox UI shows a stale thread on click and never refreshes from Telegram, which both confuses the operator and starves the suggestion pipeline of input.

## What Changes

- **BREAKING**: Rename `ConversationMode.auto` → `ConversationMode.semi_auto`. Today's `auto` already behaves as semi-auto (auto-send when safe, fall through to a suggestion otherwise) — the name now matches the behavior. Introduce new `ConversationMode.auto` for fully autonomous with silent operator fallback.
- Add structured AJTBD framing to `Campaign` (job, when, forces, anxieties, desired_outcome) and propagate it into `ReplyComposer`, `HandoffDecider`, `SafetyFilter`, and the new quality gate. Replace the empty `campaign: { goal_text, value_prop }` currently passed in the `on_inbound` pipeline.
- Propagate `Campaign.defaultMode` to `Conversation.mode` at conversation creation (currently dropped on the floor).
- Add a **conversation quality gate** — a new agent (`GoalFitEvaluator`) that scores how well the latest exchange tracks the campaign's AJTBD and produces an action (`continue | soften | handoff_silent`). Wire it into the `on_inbound` pipeline after `HandoffDecider` so its decision composes with safety risk and intent.
- In `auto` mode, when the gate returns `handoff_silent`: flip `Conversation.mode` to `assisted`, suppress auto-send, leave the highest-scoring safe suggestion as `pending` for the operator, and **do not** send any contact-visible signal. Operator response cadence resumes naturally.
- In `semi_auto` mode, the gate raises the auto-send floor (require both safety AND goal-fit above threshold) and downgrades borderline replies to `pending` rather than sending.
- Add a new `ConversationSync` service + queue: on `GET /conversations/:id` (and on inbox `pick`), backfill any missed inbound TG messages via the existing GramJS `GetDifference` path before responding, then enqueue `agent-run on_inbound` for each newly persisted inbound so suggestions reflect the latest state.
- Surface gate decisions to the operator (not the contact): emit `quality.gate` realtime event with `{ score, action, reason }` and persist the latest decision per conversation so the inbox can show "AI handed off — reason: …".

## Capabilities

### New Capabilities

- `chat-autonomy-modes`: per-conversation mode (`manual | assisted | semi_auto | auto`), mode propagation from campaign default, mode-driven branching in the `on_inbound` pipeline, and the runtime contract for silent operator fallback.
- `conversation-quality-gate`: AJTBD-aware scoring of conversation goal-fit, decision policy (`continue | soften | handoff_silent`), composition with safety + intent signals, and audit trail per inbound.
- `campaign-ajtbd-framing`: structured AJTBD object on `Campaign`, validation, propagation into all conversation-stage agents, and seed/admin surfaces for editing.
- `inbox-conversation-resync`: explicit on-open sync of a conversation against Telegram (gap fill via `GetDifference`), idempotent persistence of recovered inbounds, and triggering of the suggestion pipeline for them.

### Modified Capabilities

<!-- No prior specs exist under openspec/specs/; all behavior is captured as new capabilities above. -->

## Impact

- **Schema (Prisma)**: rename `ConversationMode.auto` → `semi_auto`, add `auto` (now stricter); add structured AJTBD JSON column on `Campaign` (or sub-fields) with zod validation; add `qualityDecision` JSON snapshot on `Conversation` (latest gate output). Migration must remap existing rows: `auto` → `semi_auto`.
- **Agents**: new `GoalFitEvaluator` agent + registry entry + seed. `ReplyComposer`, `HandoffDecider`, `SafetyFilter` input schemas extended with `ajtbd` block.
- **Workers**: `agent-run on_inbound` gains gate step; `tryAutoApprove` keys off mode + gate result. New `conversation-sync` queue/service; bound to API route handler.
- **API**: `GET /conversations/:id` triggers sync (sync-then-respond, with timeout fallback to stale read); new realtime event `quality.gate`; `PATCH /conversations/:id/mode` accepts `semi_auto`.
- **Web**: inbox shows mode + last gate decision; `pick` flow waits on sync result; backwards-compat for users mid-session whose cached query data references `auto` (UI label remap).
- **Seeds**: `agent_config` row for `GoalFitEvaluator`; existing campaigns get a default AJTBD scaffold to fill in.
- **Tests**: agent unit tests with mocked LLM; integration test for the gate's effect in `on_inbound`; sync-on-open integration test using mocked TG client; e2e click-and-recover scenario.
- **Operator UX**: mode picker in conversation header gains "Semi-auto" / "Auto" entries; tooltip explains silent-fallback behavior. No contact-visible changes (deliberate).
