# Changelog

All operator-visible changes worth noting between releases.

## Unreleased

### Added

- **«Убрать дубли» в инбоксе.** Кнопка над списком диалогов (admin/operator)
  схлопывает дублирующиеся диалоги по каналам: на канал остаётся один тред.
  Чаты, где уже была переписка (входящие ИЛИ исходящие), всегда сохраняются —
  «если я уже кому-то написал, оставляем этот чат». Удаляются только пустые
  дубликаты, по которым ещё никто не писал; если на канале пусто во всех, по
  приоритету роли остаётся лучший контакт (`ad_manager` > `owner` > `generic` >
  …). Холодные лиды без канала не трогаются. Удаление пустых тредов безопасно
  для учёта: `agent_run` сохраняются (ссылка обнуляется), теряются только
  эфемерные pending-подсказки опенинга. Эндпоинт `POST /conversations/dedupe`.

- **`bot` contact type** (openspec change `add-bot-contact-type`). Some bloggers
  publish only an advertising bot as their business contact (e.g. «по рекламе —
  @hadeout_bot»). These are now captured as a first-class `bot` contact type
  instead of being dropped or mislabeled as a plain username. The extractor
  classifies a `*_bot` handle as `bot` only when the surrounding text shows it's
  an ad/intake channel; service bots without ad context are still ignored. Bot
  contacts are TG-reachable and show a distinct icon in the contacts list, with
  `bot` available in the type filter, create dialog, and edit drawer. They are
  deliberately **excluded from automated campaign dispatch** — an ad bot expects
  a /start/menu flow, not a human-framed opener — so operators reach them
  manually from the inbox.

- **Structured placement offers** (openspec change `entity-style-rate-cards`).
  Blogger quotes are now extracted as structured commercial offers — each with
  a stable `kind` plus typed attributes (platform, duration, deletion policy,
  included deliverables, tax, notes), confidence, and source provenance —
  instead of only flat `rate.<format>` price points. A day post and a month
  post no longer collapse into one price; tax (e.g. «налог 6%») is kept as an
  attribute rather than a phantom price row. The blogger profile page renders a
  new "Размещения" card showing each offer's terms with its raw source snippet;
  the legacy price table remains as a fallback. The data-collection planner now
  asks focused follow-ups for missing terms (deletion policy, duration, tax,
  deliverables) instead of re-asking for the whole rate card, and blogger
  matching can rank on structured terms (e.g. a long-lived Telegram post over a
  one-day post). Extraction may propose new attributes it sees in real quotes;
  proposals stay inactive until an admin approves them under a new
  **Settings → admin** review surface (`/placement-attributes`). Everything is
  gated by the new **`structured_placement_offers`** feature flag
  (Settings → Features, admin-only, default off) with a legacy-only fallback;
  legacy `rateCards`/`formats` stay populated (derived from offers) during
  rollout. Ships a DB migration (`blogger_profile.placement_offers` column +
  `placement_attribute` registry/proposals table).

### Fixed

- **Campaign dispatch writes to the channel's ad/manager contact, not its
  owner.** When a channel published both an explicit advertising contact
  («Сотрудничество: менеджер @leksamng», `ad_manager`) and a general owner /
  «По вопросам» contact (`owner`), the dispatcher could open the conversation
  with the owner — it ranked candidates by `confidence` alone, so a
  higher-confidence owner outran the manager, and with no per-channel dedup it
  even messaged both. The dispatcher now keeps at most one contact per channel
  and picks the best by role first (`ad_manager` > `owner` > `generic` > `bot`
  > `unknown`), then type, then confidence — matching `ContactPrioritizer`. A
  contact an operator explicitly dropped into the campaign («В кампанию») still
  wins within its channel. Cold-lead contacts (no channel) are unaffected.

- **Production console errors — realtime restored & noise removed**
  (openspec change `fix-prod-console-errors`). Three production-only
  defects fixed: (1) the inbox WebSocket (`wss://outreach.su/socket.io/`)
  failed in an endless reconnect loop — the k8s Ingress applied its
  `/api`-prefix `rewrite-target` to every path, stripping `/socket.io`
  to `/`; socket.io now lives in its own annotation-free Ingress object so
  realtime (live messages, suggestions, status, HUD updates) works again.
  (2) Lazy-loaded pages (e.g. Контакты) could fail after a redeploy with a
  misleading `text/html` MIME error — the static server now returns a real
  404 for a missing hashed chunk instead of the SPA shell, and the web app
  reloads once to pull the fresh bundle. (3) The inbox no longer spams
  per-conversation `data-collection` 404s while `data_collection_hud` is
  off — the public `/config` snapshot now exposes the flag and the panel
  skips the request entirely when it is off.

### Added

- **Inbox — data-collection HUD (behind `data_collection_hud` flag)** —
  a new right-panel section in the conversation view for `agency_sourcing`
  campaigns shows per-target state (`answered` / `asked` / `missing` /
  `stale`) live: which commercial data points the bot has already
  captured, which it asked about with no answer yet, and which contributing
  facts have gone past their freshness TTL. Each row carries a source
  link that scrolls the inbox to the originating message, a freshness
  pill, and a "Задать вопрос" shortcut on `missing`/`stale` rows that
  pre-fills the composer from the field's operator description. Backed
  by the new typed target-field registry in `packages/shared/src/
  data-collection-targets.ts` — single source of truth shared by the
  planner, the HUD, and the gate prompt. Default OFF; flip
  `data_collection_hud` from Settings → Features once the feature is
  validated in staging. See openspec change
  `data-collection-hud-target-fields`.

- **Agency sourcing — sponsored-integration detector** — a new
  LLM-classifier agent (`sponsored_integration_detector`) is now the
  ONLY source for `observed_integrations` fed into the agency opener
  composer. Last-N posts are no longer passed through as candidate
  integrations, so the opener cannot accidentally cite a non-sponsored
  post as «вашу интеграцию с …». If the detector finds nothing (or
  fails), the opener falls back to a generic-topic hook and the
  composer's no-fabrication guard keeps the variant non-eligible for
  auto-send. See openspec change `harden-agency-sourcing-pipeline`.

### Changed

- **Agency opener — `auto_send_eligible` is enforced** — variants the
  composer marks as not eligible (typically agency variants without a
  real sponsored integration to cite) are saved as `pending`
  Suggestions for operator review but never auto-approved, regardless
  of safety score. CustDev openers are unaffected (they don't emit
  the field). See `harden-agency-sourcing-pipeline`.

- **Full campaign-type safety profile on every outbound** —
  dispatcher, on_inbound reply, first-message opener, operator
  approve, and direct send now all go through a single
  `buildSafetyInput` helper that feeds SafetyFilter the FULL profile
  (allowed/forbidden topics, hard blocks, max_length, allow_links)
  resolved from `campaign.type.safetyProfile`. Previously some sites
  passed only `hard_block_patterns` and operator approve/direct send
  passed no profile at all. See `harden-agency-sourcing-pipeline`.

- **Agency inbound: synchronous profile extraction** — for
  `agency_sourcing` conversations the inbound pipeline now runs
  `handleProfileExtract` synchronously before invoking the
  DataCollectionPlanner, so the planner sees facts in THIS inbound and
  no longer re-asks for the price the blogger just shared. Cheap
  deterministic pre-gate skips extractor calls on turns with no
  commercial signal at all (e.g. "ок, в пятницу"). Media-kit assets
  attached before the catalog profile existed are now back-filled with
  `profileId` in the same transaction. Double-failure throws so the
  BullMQ retry kicks in (was silently swallowed). See
  `harden-agency-sourcing-pipeline`.

- **Agency goal-fit gate is campaign-type aware** — `GoalFitEvaluator`
  now branches its non-goals by campaign type: CustDev keeps the
  research-interview framing, `agency_sourcing` flags premature money
  commitments / fabricated client details / result guarantees. The
  AJTBD scaffold built for agency campaigns lifts
  `goal.target_data_points` into `desired_outcome`. See
  `harden-agency-sourcing-pipeline`.

- **Operator UX — agency campaign created with the flag off rejects
  fast** — campaign create/update now responds 422
  `AGENCY_SOURCING_DISABLED` instead of silently routing the campaign
  through the CustDev opener. Existing agency campaigns under a
  flag-off rollout emit a warn-log per dispatcher tick / inbound run
  and skip the agency-specific branches. See
  `harden-agency-sourcing-pipeline`.

- **Smaller agency planner fixes**: `deals_contact` removed from the
  default target set (no extractor yet — caused infinite re-asking);
  `audience_demographics` and `geo` are now distinct collected
  targets so capturing only geo no longer hides demographics from the
  planner; `client_brief` is read from `goal.client_brief` (with
  `valueProp` legacy fallback) and reaches the opener; opener
  deduplication in `addContacts` recognises both `opening_composer`
  and `agency_opening_composer`; `RateCardExtractor` no longer blindly
  prepends `rate.` to whatever the LLM returns (`reach.story` is
  dropped, not stored as `rate.reach.story`).

### Added

- **Inbox: per-campaign filter and friends** — the inbox now exposes a
  filter bar with campaign / status / mode dropdowns and a debounced
  contact/channel text search. State lives in the URL, so reloads and
  shared links restore the same view; user-initiated changes use
  `router.push` (back/forward navigates between filter states), while
  auto-selecting the first conversation uses `router.replace` so it
  doesn't pollute history. The campaign detail page now has an "Инбокс
  кампании" action that deep-links into `/inbox?campaignId=<id>`.
  `assignedOperatorId` is honoured via deep-link (no UI picker yet —
  `GET /users` is admin-only and the inbox is shared with operators /
  viewers; a role-safe lookup will come in a follow-up change). The
  shared `ConversationFiltersZ` schema gained empty/whitespace
  normalisation for enum/id fields and a `q.max(200)` cap to keep the
  downstream `ILIKE` scan bounded. See openspec change
  `inbox-campaign-filter`.

### Changed

- **`downloadInboundMedia` is now unit-tested** — the tg-client method
  that backs the inbound media-asset pipeline was previously covered only
  indirectly via the `mediaStore` tests in workers. Extracted the core
  logic into the exported helper `downloadInboundMediaWithClient` (pure,
  takes a minimal `DownloadMediaClient` shape) and added 13 unit tests
  covering every branch of the contract (invalid msgId, no message, no
  media, missing `downloadMedia`, throws, null/string/Uint8Array/Buffer/
  unsupported returns, correct `getMessages` argument shape, never
  throws). Behavior is unchanged. A `RUNBOOK.md` in the archived
  openspec change documents the live-smoke procedure operators run
  before flipping `object_storage` on in prod. See openspec change
  `verify-download-inbound-media`.

### Added

- **A/B opener variants** — the opener composers
  (`opening_composer` and `agency_opening_composer`) now stamp each
  variant with a stable `variantKey` (LLM can supply a semantic key
  like `'concise'` / `'with_brand'`; otherwise a deterministic
  post-process assigns `'A'`, `'B'`, `'C'`, …). The key flows through
  `Suggestion.meta.openerVariant` into the new `Message.openerVariant`
  column, both on the auto-send path (`tryAutoApprove`) and the
  operator-approve path (`approveSuggestion`). A new read-only
  `GET /campaigns/:id/opener-stats?withinHours=<H>` endpoint returns
  per-variant `{ variantKey, sent, replied, replyRate }` rows (default
  `withinHours=48`, capped at 30 days). No feature flag — purely
  additive observability layered on top of the existing opener flow.
  See openspec change `ab-opener-variants`.

- **Batch channel discovery** — operators can submit up to 50 niches at
  once via `POST /discovery/batch` and poll progress through
  `GET /discovery/batch/:id`. A `DiscoveryBatch` row tracks the request,
  the new `discovery-batch` worker iterates the niches sequentially
  (concurrency 1 + a 1-second rate-limit pause between calls) and
  pushes new channels through the existing `channel-scrape` →
  `contact-extract` intake. Per-niche failures are recorded in the
  batch summary and don't abort the run; the operator sees exactly
  which niches succeeded vs errored. Behind the `channel_discovery`
  runtime flag like single-niche discovery. See openspec change
  `batch-channel-discovery`.

- **SafetyFilter deterministic hard-block** — campaign-type
  `safetyProfile` gains a `hard_block_patterns` list of regex rules with
  ids and human-readable reasons. SafetyFilter evaluates them BEFORE the
  LLM scoring step; any match forces `allow=false`, `risk_score=1`, and
  a structured `reason` line. The LLM stays advisory. The
  `agency_sourcing` seed ships with six patterns covering result
  guarantees (verbal/adjective/numeric/English forms), time-pressure
  tactics, and pre-operator payment mentions;
  CustDev gets an explicit empty list (legacy advisory-only behavior).
  Malformed patterns are skipped without crashing the pipeline. See
  openspec change `safety-filter-hard-block`.

### Removed

- **`Campaign.ajtbd` column** — the legacy JSON column was a parallel
  storage to `Campaign.goal`; for `custdev` campaigns it carried the
  same AJTBD payload, for `agency_sourcing` it held a synthetic
  scaffold nobody edited. Runtime consumers (`HandoffDecider`,
  `ReplyComposer`, `GoalFitEvaluator`, the worker `agent-run.ts`, web
  `CampaignForm.vue`, the campaigns service) now read the AJTBD view
  from `Campaign.goal` via a new pure helper
  `extractAjtbdView({ goal, goalText, valueProp })` exported from
  `@nosquare/shared` — passthrough when goal carries the AJTBD-shape
  (CustDev), scaffold from `goalText` + `valueProp` otherwise. Two
  migrations land together: `9b_backfill_campaign_goal_from_ajtbd`
  copies any unset `goal` from `ajtbd`, then
  `9c_drop_campaign_ajtbd` removes the column. API request/response
  schemas (`CampaignZ`, `CreateCampaignInputZ`, `UpdateCampaignInputZ`)
  no longer accept or return `ajtbd`. No behavior change for agents —
  they still consume an AJTBD input contract. See openspec change
  `drop-campaign-ajtbd-column`.

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
