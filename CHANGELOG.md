# Changelog

All operator-visible changes worth noting between releases.

## Unreleased

### Added

- **Campaign types (agency sourcing & matching)** — campaign goal/framing/
  safety/agent-set moved out of hardcoded CustDev into a configurable
  `campaign_type` registry. CustDev is now the seeded `custdev` type; a new
  `agency_sourcing` type poses as a media-buying agency to collect rate cards,
  reach and audience stats into a standardized, matchable blogger catalog.
  Behind feature flags (off by default); CustDev behavior is unchanged until
  enabled.
  - **Campaign-type builder**: describe a campaign goal in plain language and
    a meta-agent drafts the agent set (prompts, models, output schemas), dry-
    runs them, and saves an editable type — never auto-published.
  - **Agency dialogue**: agency-framed opener referencing the blogger's own
    ad, a data-collection planner, and a commercial-language safety profile;
    price/quote intents force operator handoff.
  - **Blogger catalog**: standardized profiles (rate cards, reach, audience)
    with per-fact provenance; uploaded media kits + raw replies stored in S3
    (presigned download).
  - **Matching**: submit an ad brief → ranked relevant bloggers with rationale
    (deterministic, optional bounded LLM re-rank).
  - Web: campaign-type builder, type-aware campaign goal editor, blogger
    catalog/profile views, and a brief→match screen.

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
