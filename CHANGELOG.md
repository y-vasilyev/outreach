# Changelog

All operator-visible changes worth noting between releases.

## Unreleased

### Removed

- **`packages/shared/src/flags.ts`** — the "compile-time" flags module
  (`ENABLE_LLM_CONTACT_EXTRACTION`, `ENABLE_AUTO_MODE`,
  `ENABLE_FOLLOWUP_CRON`, `ENABLE_QUALITY_REVIEW`,
  `MAX_DRY_RUN_TOKENS`, `DEFAULT_DAILY_MSG_LIMIT`,
  `DEFAULT_DAILY_NEW_CONTACT_LIMIT`, `WARMUP_STAGES`, and the
  derived `FeatureFlag` type) had no consumers anywhere in
  `packages/` or `apps/` — neither static imports nor dynamic
  `flags['…']` access. Deleted along with its `index.ts` re-export.
  All operational toggles in the system are now runtime flags
  (`feature_flag` table + admin UI). No behavior change. See
  openspec change `remove-dead-flags-ts`.

### Fixed

- **`prisma migrate deploy` on a fresh Postgres cluster** — the
  `4_chat_autonomous_modes` migration previously combined
  `ALTER TYPE "ConversationMode" ADD VALUE 'semi_auto'` with `UPDATE`
  statements that referenced the freshly-added enum value in the same
  transaction; Postgres rejects that with `unsafe use of new value
  'semi_auto' of enum type ConversationMode`, so any clean prod
  deploy failed. The backfill is now split into a separate
  `9a_chat_modes_backfill_semi_auto` migration, which runs after
  migration 4 commits and is idempotent on a clean cluster. No
  user-facing behaviour change; legacy `mode='auto'` /
  `defaultMode='auto'` rows are still backfilled to `semi_auto`,
  just in a separate transaction. See openspec change
  `fix-migration-4-enum-tx`.

### Added

- **Channel discovery via web search** — find candidate blogger channels by
  niche through the Yandex Search API and queue them straight into the existing
  scrape → contact-extract intake (`POST /discovery/search`, admin/operator).
  Results are normalized to platform handles (telegram/instagram/youtube),
  de-duplicated, and only genuinely new channels are created + scraped. Behind
  the `channel_discovery` runtime flag (default off); the Search key is stored
  encrypted as a `yandex_search` integration.

- **Runtime feature flags** — operational rollout/kill-switch flags
  (`campaign_types`, `agency_sourcing`, `object_storage`, `blogger_matching`)
  moved from compile-time constants into the DB, toggleable from a new
  admin-only **Settings → Features** page without a redeploy. Flips take
  effect in the API and workers immediately (Redis pub/sub), give operators
  an instant kill-switch for risky outreach, are audited, and show readiness
  hints (e.g. "S3 not configured"). An emergency env override
  (`FEATURE_<KEY>_FORCE`) can pin a flag during incidents. Defaults are all
  off, so behavior is unchanged until a flag is turned on.

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
  silent operator fallback. The enum value `semi_auto` is added by
  migration `4_chat_autonomous_modes`; existing legacy rows are
  backfilled to `semi_auto` by migration
  `9a_chat_modes_backfill_semi_auto` (split for the enum-in-tx fix —
  see `fix-migration-4-enum-tx`).
- `Campaign.defaultMode` is now applied to new conversations created under
  the campaign (previously it was set but never read).

### Operator notes

- Migration runbook for ops: see
  `openspec/changes/chat-autonomous-modes/RUNBOOK.md`.
