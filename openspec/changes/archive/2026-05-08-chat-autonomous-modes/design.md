## Context

The CustDev outreach pipeline today runs every inbound through `agent-run on_inbound` (`apps/workers/src/queues/agent-run.ts`) which calls, in order: `IntentClassifier` → `HandoffDecider` → `ReplyComposer` → per-variant `SafetyFilter` → suggestion persistence → optional `tryAutoApprove` (`apps/workers/src/services/auto-approve.ts`, threshold `score ≥ 0.8`). `Conversation.mode` is `auto | assisted | manual` (Prisma enum). Today's `auto` only auto-approves when `1 - risk_score ≥ 0.8`; otherwise it leaves a `pending` Suggestion. There is no model-side notion of "is this conversation still tracking the campaign goal?", and no path for an autonomous chat to silently hand off without a contact-visible artifact (e.g., a delayed AI reply that never arrives).

`Campaign.goalText` and `valueProp` exist but are **not propagated** to `ReplyComposer` in the inbound pipeline (passed as empty strings, line 152). `Campaign.defaultMode` exists but is **not** applied at conversation creation. AJTBD framing is not currently modeled at all.

Inbound message receipt has two paths in `packages/tg-client/src/SessionManager.ts`: a GramJS `NewMessage` event listener and a poll using `updates.GetDifference`. Both feed `tg-listen` jobs that persist messages and enqueue `on_inbound`. There is **no** explicit per-conversation backfill triggered by the operator opening a chat; the inbox UI in `apps/web/src/features/inbox/ConversationView.vue` simply queries `GET /conversations/:id/messages` (with a 4s `refetchInterval`) and trusts the DB. After a worker outage, this shows a stale thread until the next push event arrives.

Stakeholders:
- **Operator**: needs trustworthy autonomy with a clear "AI handed this back, reason X" signal, and an inbox that always shows the actual latest contact message on click.
- **Contact**: must perceive a single, coherent voice — no "Sorry, transferring to a human" tells, no awkward latency spikes when the AI silently hands off.
- **Campaign owner**: needs to express the campaign's job-to-be-done explicitly so autonomy can be judged against it.

## Goals / Non-Goals

**Goals:**
- Two distinct autonomy levels (`semi_auto`, `auto`) with semantics that make their difference visible to operators but invisible to contacts.
- A goal-fit decision step grounded in AJTBD framing, composed (not replaced) with existing safety + intent signals.
- Silent operator fallback: when the gate trips in `auto` mode, the conversation drops to `assisted` with no contact-side artifact and no telltale latency change beyond what an operator-paced response already produces.
- Inbox-on-open consistency: clicking a conversation never shows a thread that's older than what Telegram has, even after a worker restart.
- Campaign AJTBD framing flows end-to-end into agent inputs without a hardcoded fallback in code.

**Non-Goals:**
- Replacing or merging existing agents (`HandoffDecider`, `SafetyFilter`, `IntentClassifier`). The gate composes with them, not supplants them.
- Building a separate "autonomous controller" service. Autonomy lives inside the existing `on_inbound` pipeline.
- Real-time streaming of TG history. We backfill on demand (chat open) and via existing push/poll. No always-on per-conversation `GetDifference` loop.
- Cross-conversation learning, RLHF, or quality model retraining. This change adds a deterministic decision policy on top of LLM scoring; tuning happens via prompts and thresholds.
- Changing campaign opener flow (`OpeningComposer`) — this proposal is strictly about the inbound/reply side.

## Decisions

### Decision 1: Rename `auto` → `semi_auto`, introduce new `auto` semantics

Today's `auto` already behaves like a semi-auto (auto-send when safe, suggest otherwise). Renaming aligns the enum with reality and frees the `auto` token for the new strict-with-silent-fallback mode. Migration is a single Prisma data migration (`UPDATE conversation SET mode = 'semi_auto' WHERE mode = 'auto'`), plus a corresponding `Campaign.defaultMode` migration.

**Alternatives considered:**
- *Add a boolean flag `silentFallback` on Conversation*: less expressive — operators want to *pick* a mode, and a boolean buried in settings is a poor UX surface.
- *Introduce a new mode name like `autonomous` and leave `auto` semantics alone*: keeps the migration trivial but cements a misleading name and forces every code path to remember "`auto` means semi-auto here." Net cost is higher long-term.

**Trade-off:** The rename is BREAKING for any external integration referencing the literal `auto`. We accept this because the project is pre-1.0, the enum is referenced in roughly a dozen TS sites and a single seed file, and the rename is mechanical.

### Decision 2: A new `GoalFitEvaluator` agent that runs after `HandoffDecider` and gates auto-send

Place the gate at the same pipeline layer as `HandoffDecider` (which already produces `ai_continue | ai_suggest_only | operator_now`) but downstream of it, so a hard handoff signal short-circuits the gate entirely. The gate consumes: latest N messages, intent + confidence, handoff decision, AJTBD block, and last gate decision (for hysteresis). It returns `{ score: 0..1, action: continue | soften | handoff_silent, reasons: string[] }`.

**Composition rule** (codified in `auto-approve.ts`):
- `mode = manual`: no auto-send ever (unchanged).
- `mode = assisted`: no auto-send ever (unchanged).
- `mode = semi_auto`: auto-send iff `safety.allow && (1 - risk_score) ≥ T_safety && gate.action ∈ {continue, soften} && gate.score ≥ T_semi_auto_goalfit`. Otherwise leave a `pending` suggestion (today's fallback behavior).
- `mode = auto`: auto-send iff above AND `gate.action == continue` AND `gate.score ≥ T_auto_goalfit` (stricter). If `gate.action == handoff_silent`, set mode to `assisted`, persist `qualityDecision` snapshot, leave the best safe suggestion as `pending`, emit `quality.gate` to operators only. **No outbound is created or sent.**

Default thresholds (configurable via env, persisted in agent params): `T_safety = 0.8`, `T_semi_auto_goalfit = 0.6`, `T_auto_goalfit = 0.75`. Tunable per campaign via `agentOverrides.goal_fit_evaluator`.

**Alternatives considered:**
- *Fold the gate into `HandoffDecider`*: `HandoffDecider` already escalates when the contact is hostile or off-topic in a hard way. The gate's job is more nuanced — judging *fit to goal* even on civil, on-topic exchanges. Mixing these into one prompt blurs the model's decision and makes thresholds harder to reason about.
- *Use only `SafetyFilter.risk_score` as the gate*: safety is necessary but not sufficient. A reply can be safe yet drift far from the AJTBD (e.g., contact wants partnership terms, agent keeps doing CustDev intro). We need a separate goal-fit signal.
- *Run gate before reply composition to skip composition entirely on bad fit*: tempting for cost, but composing first lets the gate evaluate against an actual draft, which is more accurate than evaluating against a hypothetical reply. Cost mitigation: only run the gate when `mode ∈ {semi_auto, auto}`.

### Decision 3: AJTBD as a structured object on `Campaign`

Add `Campaign.ajtbd` as a JSON column with a zod-validated shape:

```
{
  job: string,                  // "When [situation], I want to [motivation], so I can [outcome]."
  when: string,                 // trigger / situation
  forces: { push: string[], pull: string[], anxieties: string[], habits: string[] },
  desired_outcome: string,
  non_goals: string[]           // explicit anti-goals, e.g. "do not pitch ad placement"
}
```

Stored as JSON for evolvability; validated at write time via zod in `apps/api/src/routes/campaigns.ts`. Backfill: existing campaigns get a scaffold `{ job: goalText, when: '', forces: { ... empty arrays }, desired_outcome: valueProp, non_goals: [] }` so the gate has *something* to score against on day one. Admin UI gets a dedicated AJTBD editor section.

**Alternatives considered:**
- *Free-text "campaign brief"*: simpler for admins to write, but harder for the model to consume reliably and impossible to validate. We'd lose the ability to check "are you describing a non-goal?" cleanly.
- *Separate normalized table*: overkill. AJTBD is a single record per campaign, mostly read together. JSON is right.

### Decision 4: Sync-on-open via a `ConversationSync` service

Add `services/conversationSync.ts` (`apps/api/src`) with a single method `syncOne(conversationId)`:
1. Look up `Conversation.lastSyncedAt` and the `tg_account` it belongs to.
2. Acquire the existing `tg-client` for that account; call a new `tg-client` method `fetchSinceMessage(peerId, lastTgMsgId)` that wraps `messages.getHistory` (bounded, e.g. last 50 messages, descending).
3. For each message newer than what's in the DB (dedupe on `tgMsgId` per conversation), persist via the same path `tg-listen` uses, then enqueue `agent-run on_inbound`.
4. Update `Conversation.lastSyncedAt`.

Trigger points:
- **API** `GET /conversations/:id`: call `syncOne()` with a hard timeout (default 1500ms). If it completes within the budget, respond with the post-sync state. If it times out, respond with current DB state and let the sync continue in the background; the UI will pick up newly persisted messages via the existing realtime `message.new` event.
- **Web** `ConversationView.vue` on `pick`: existing query already fires `GET /conversations/:id`; no separate UI change required beyond updating types if response shape changes.

**Why `messages.getHistory` and not `updates.GetDifference`?** `GetDifference` is account-global and already runs in the poll loop in `SessionManager`; it's the wrong tool for "this one peer right now." `messages.getHistory` is per-peer, returns a bounded, ordered slice, and is cheap enough that we can run it on every chat open without a quota concern.

**Idempotency:** dedupe is already enforced by the unique index on `(conversationId, tgMsgId)` in the `Message` table. Re-running the on_inbound pipeline for a backfilled message is safe — `IntentClassifier` is read-only over messages, and `ReplyComposer` produces fresh suggestions that get persisted alongside any older ones (operator sees both). To avoid suggestion spam after a long outage, cap suggestion regeneration to **only the most recent inbound** per conversation per sync; older backfilled messages are persisted but don't each spawn their own suggestions.

**Alternatives considered:**
- *Background sync only, no on-open trigger*: doesn't solve the user's reported symptom (operator sees stale thread immediately on click).
- *Trigger sync from UI directly via a dedicated "Sync" button*: shifts cognitive load to the operator. The whole point is consistency-by-default.
- *Always block the GET response on sync*: bad tail latency. The 1500ms budget with graceful degradation balances freshness with responsiveness.

### Decision 5: "Silent" fallback semantics

"Silent" means:
- No outbound message is created or sent on the gate-triggered transition.
- No realtime event reaches the contact-facing layer (only `quality.gate` to the operator room).
- The conversation's mode flips to `assisted` so subsequent inbounds route through suggestion-only, matching what the operator now drives manually.
- The operator's UI shows a subtle indicator ("AI handed off — goal-fit dropped: <reason>") and the latest pending suggestion, but typing rhythm and timing are now driven by the human.

The contact perceives only the natural pause between their message and the operator's eventual reply — same surface as if the operator had been manning the chat the whole time.

**Trade-off accepted:** the operator may take longer to respond than the AI would have. This is a deliberate UX decision — the alternative (auto-send a degraded reply) is the failure mode we're trying to avoid.

### Decision 6: Persist gate decisions on `Conversation`

Add `Conversation.qualityDecision` as JSON: `{ score, action, reasons, agentRunId, decidedAt }`. Snapshot of latest decision only (not history; full history lives in `AgentRun`). The inbox header reads this to show the current AI state ("AI on track / AI handed off"). Resetting on operator action: when the operator manually flips mode back to `auto`, clear `qualityDecision`.

## Risks / Trade-offs

- **[LLM cost spike from gate running on every inbound]** → Gate runs only when `mode ∈ {semi_auto, auto}`. For `manual` and `assisted`, it's skipped. We use the cheapest model tier (Haiku-class) for the gate by default since it produces a structured score, not creative text. Cap input to the last 8 messages.
- **[False-positive handoffs starve auto mode]** → We add hysteresis: gate decision must trip `handoff_silent` twice in a row (or once with `score ≤ 0.3`) before flipping mode. Per-campaign override exists. We also log `qualityDecision` history via `AgentRun` so we can tune thresholds from real data.
- **[Sync-on-open masks broader sync issues]** → A persistent gap between `tg-listen` push and DB indicates a real outage that needs alerting. We'll keep the existing push-path metrics and add a counter for "messages first persisted via syncOne" — a non-trivial rate is a signal that the push path is failing.
- **[Backfilled inbounds during a long outage create a flood of `on_inbound` jobs]** → As stated in Decision 4, only the most recent backfilled inbound per conversation triggers the suggestion pipeline. Older messages are persisted (so operator can read them) but don't each spawn LLM work.
- **[Silent mode flip surprises the operator]** → Always emit `quality.gate` realtime to the operator room and surface a clear banner in the conversation header. Add to `AGENTS.md` so behavior is documented.
- **[Migration-time mode rename racing with in-flight jobs]** → Run the data migration in a maintenance window, drain `agent-run` queue first, then deploy. Optionally double-write/double-read briefly: accept both `auto` and `semi_auto` as input and normalize on write for one release.
- **[`messages.getHistory` cost / FloodWait]** → Bounded fetch (50 messages descending), TTL-cached per conversation for 30s on the API side to deduplicate rapid clicks; falls back gracefully on FloodWait by returning current DB state with a log line.

## Migration Plan

1. **Schema migration #1**: add `Conversation.qualityDecision`, `Conversation.lastSyncedAt`, `Campaign.ajtbd` columns. Backfill `ajtbd` from `goalText`/`valueProp` for existing campaigns.
2. **Schema migration #2**: add `semi_auto` to `ConversationMode` enum (Postgres allows enum value addition without `auto` removal). Deploy.
3. **Code change #1**: ship double-accept logic — API/seed/types accept both `auto` and `semi_auto`, normalize to `semi_auto` on write. Ship `GoalFitEvaluator` agent, sync service, gate composition, and AJTBD propagation.
4. **Data migration**: `UPDATE conversation SET mode = 'semi_auto' WHERE mode = 'auto'`. Same for `Campaign.defaultMode`.
5. **Schema migration #3**: drop `auto` value from enum, then re-add `auto` with new semantics (Postgres requires this to be a multi-step operation; or simply add `auto_strict` then rename in a later release if the dance is too risky).
6. **Code change #2**: introduce new `auto` mode handling and remove backward-compat `auto`-as-semi-auto normalization.
7. **Web**: ship UI changes (mode picker labels, gate banner, AJTBD editor) in step 3; cosmetic only.

**Rollback**: each step is independently revertible. The riskiest step is the enum dance — if step 5 fails, we keep `semi_auto` and `auto_strict` and skip the rename, accepting a slightly less elegant final naming.

## Open Questions

- Should the gate also short-circuit `ReplyComposer` when prior conversation history strongly suggests handoff (cost optimization)? Current decision: no, we compose first to evaluate against a real draft, but worth revisiting once we see real cost numbers.
- Do we want `Campaign.ajtbd.non_goals` to be enforced as a hard SafetyFilter rule (e.g., "the contact mentioned 'ad placement' — do not engage") or just as gate input? Initial answer: gate input only; SafetyFilter remains general-purpose. Revisit if non-goal violations slip through.
- Should the silent fallback be reversible by the AI itself (auto-resume after a few good operator turns) or require explicit operator opt-in? Initial answer: explicit opt-in only — auto-resume risks ping-ponging. Operator clicks "Resume auto" in the conversation header.
