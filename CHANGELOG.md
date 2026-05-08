# Changelog

All operator-visible changes worth noting between releases.

## Unreleased

### Added

- **Chat autonomy modes** — per-conversation `auto` / `semi_auto` / `assisted` /
  `manual` with a model-driven goal-fit gate (`GoalFitEvaluator`). In `auto`
  mode, when the gate detects the conversation has drifted off the campaign's
  AJTBD goal, the conversation flips silently to `assisted` — the operator
  picks up at human pace and the contact perceives nothing.
- **AJTBD framing on campaigns** — structured `Campaign.ajtbd` (job, when,
  forces, desired_outcome, non_goals) propagated into `ReplyComposer`,
  `HandoffDecider`, `SafetyFilter`, `GoalFitEvaluator`. AJTBD editor in the
  campaign settings page.
- **Quality-gate banner** on the inbox conversation header: when AI hands off
  silently, operator sees "AI handed off — <reason>" with a "Resume auto"
  button.
- **On-open conversation sync** — `GET /conversations/:id` now fetches missed
  TG messages (≤ 50, bounded, FloodWait-friendly, 30s cache) and feeds the
  most recent new inbound to the agent pipeline so suggestions reflect the
  latest state. Fixes "stale chat after worker restart" bug where messages
  received during downtime never reached the inbox until the next push.

### Changed

- **BREAKING**: `ConversationMode.auto` renamed to `semi_auto` (matches
  pre-existing behaviour). New `auto` mode introduces strict semantics with
  silent operator fallback. Existing rows are migrated automatically by
  migration `4_chat_autonomous_modes`.
- `Campaign.defaultMode` is now applied to new conversations created under
  the campaign (previously it was set but never read).

### Operator notes

- Migration runbook for ops: see
  `openspec/changes/chat-autonomous-modes/RUNBOOK.md`.
