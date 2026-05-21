## Context

The codebase implements one outreach motion end to end: CustDev interviews. The goal ("20-min product interview, never sound like ad sales") is encoded in agent prompts, in `SafetyFilter`'s `forbidden_topics` defaults, in the AJTBD framing made mandatory on every campaign, and in `GoalFitEvaluator`'s autonomy gate. `CLAUDE.md` "Чего не делать #7" enshrines "never turn CustDev into a sale."

The new business motion is the inverse: pose as a media-buying agency, open off a blogger's existing ad post ("we have a client who wants a similar integration"), negotiate price/timelines/formats, and harvest reach + audience stats — to build a catalog of ~200 bloggers and match them to incoming ad briefs. Per product direction this is not a one-off second mode but the first instance of a general capability: **campaign types are data, authored by a builder, configurable in the UI** — CustDev and agency become two seeded rows.

Constraints carried from the existing architecture: validation at boundaries (zod), service layer (routes never touch GramJS/LLM/Prisma directly), all LLM calls through `AgentRunner` writing `agent_run`, no message sent without a prior `message(pending)`, errors drop a conversation to `assisted` rather than going silent, UTC everywhere, secrets redacted.

## Goals / Non-Goals

**Goals:**
- Move campaign goal/framing/agent-set/safety/autonomy out of code into a `campaign_type` registry that the existing pipelines resolve at runtime.
- Provide a builder that turns a plain-language goal into a drafted, model-selected, prompt-written, test-run agent set, saved as an editable campaign type.
- Ship the agency sourcing type: agency-framed opening, data-collection dialogue, commercial-language-permitting safety profile.
- Standardize harvested commercials/metrics into a `blogger_profile` while preserving raw replies; store uploaded files + raw payloads in S3.
- Match an incoming ad brief to ranked catalog bloggers with rationale.
- Keep CustDev behavior bit-for-bit intact (it becomes the `custdev` seeded type).

**Non-Goals:**
- Replacing the existing autonomy modes (`manual/assisted/semi_auto/auto`) — they remain; only the *goal* the gate evaluates against becomes type-driven.
- Full media/voice outreach, or sending files outbound.
- A learning loop that auto-tunes prompts from outcomes (the builder runs tests but does not optimize against live KPIs).
- Multi-tenant isolation of types.
- Replacing manual operator confirmation for price negotiation — agency dialogues default to `assisted` until trust is established.

## Decisions

### D1: Campaign type is a first-class table, pipelines resolve behavior from it
A `campaign_type` row carries: `key` (`custdev`/`agency_sourcing`/…), `goal_schema` (JSON-schema describing the structured goal object a campaign of this type stores), `agent_set` (ordered map of pipeline-role → `agent_config` reference + overrides), `safety_profile` (forbidden/allowed vocabulary, link policy, escalation intents), `autonomy_policy` (gate thresholds, which intents force handoff). `campaign.type_id` FK; the campaign's structured goal lives in `campaign.goal` (JSON validated against the type's `goal_schema`).

Pipelines (`outreach_first_message`, `on_inbound`, `followup_check`, gate composition in `auto-approve.ts`) read the type to decide which agents to run and with what safety/goal context. The `Orchestrator` already executes pipelines-as-data; we make the step list itself a property of the type rather than a hardcoded constant.

*Alternative considered*: a `kind` enum + `switch` in code. Rejected — the product requirement is operator-authored types via a builder; an enum can't be created from the UI and would re-hardcode the very thing we're extracting.

### D2: AJTBD generalizes to a per-type goal schema
`campaign-ajtbd-framing` currently mandates `ajtbd` on every campaign. We relax this: the `custdev` type's `goal_schema` *is* the AJTBD shape, and existing campaigns' AJTBD is migrated into `campaign.goal` for the `custdev` type. `GoalFitEvaluator` receives `campaign.goal` + the type's goal definition rather than `ajtbd` specifically. The agency type's goal schema describes the data-collection objective (which fields must be harvested, what "in-frame" means).

*Alternative considered*: keep `ajtbd` column and add a parallel `agency_goal` column. Rejected — doesn't generalize; every new type would add a column.

### D3: The builder is a meta-agent producing draft config, never auto-publishing
`CampaignTypeBuilder` takes `{ goal_description, examples?, constraints? }` and emits a draft `campaign_type` + draft `agent_config`s (prompts, model picks, params, output JSON-schemas). It then runs each drafted agent against generated/seeded `agent_test_fixtures` via the existing `dry_run` path, attaches results, and returns the draft for operator review. Saving the draft creates real `agent_config` rows + `agent_config_history` v1. Model selection uses a capability map (cheap/medium/strong → endpoint+model) seeded per available `endpoint`; the builder picks a class per agent role, not a hardcoded model.

*Alternative considered*: builder writes directly to live config. Rejected — violates the "operator reviews dangerous changes" + audit norms, and untested prompts could ship.

### D4: Blogger profile is normalized + raw-preserving
`blogger_profile` is the standardized catalog row (one per blogger/channel), holding typed columns/JSON for the matchable fields: topics, audience demographics (age/gender/geo split), reach/avg-views, languages, formats offered. Granular harvested facts land in `profile_data_point` rows `{ profile_id, field, value, unit, source_message_id, confidence, extracted_by, raw_snippet }` so we keep provenance and can re-derive the rolled-up profile. Raw replies stay in `message` (already) and, for structured harvest, in `profile_data_point.raw_snippet`; full raw payloads/files go to S3 (D5). Extractor agents (`RateCardExtractor`, `AudienceStatsExtractor`) emit `profile_data_point`s; a deterministic roll-up composes `blogger_profile`.

*Alternative considered*: dump everything as JSON on the conversation. Rejected — not queryable for matching, loses provenance/confidence.

### D5: S3 / object storage for files and raw payloads
Add an `ObjectStore` service in a small package (`packages/storage`) wrapping the S3 SDK (S3-compatible, MinIO in dev). `tg-listen` already normalizes inbound; when an inbound has media, the worker downloads via `tg-client` and puts it to S3, writing a `media_asset` row `{ conversation_id, profile_id?, kind, s3_key, mime, bytes, sha256, source_tg_msg_id }`. Raw response payloads (the verbatim message text + any structured JSON we parsed) are also snapshotted to S3 under a deterministic key for later bulk analysis. Access from UI via presigned GET URLs from the API; uploads (if any) via presigned PUT. Keys namespaced `bloggers/{profileId}/{assetId}`. `S3_*` env added to required-when-enabled config; feature-flagged so dev without S3 still runs (assets fall back to `manual`/skipped with a logged warning).

*Alternative considered*: store files as bytea in Postgres. Rejected — media kits/screenshots bloat the DB and the requirement is explicitly S3 for downstream analysis.

### D6: Matching is a two-stage filter→score over the catalog
`ad_brief` `{ topic, audience_target, budget, formats, geo, deadline, notes }` (zod-validated) → stage 1 deterministic SQL filter on `blogger_profile` (topic overlap, geo, budget vs known rate cards, format availability) → stage 2 `BloggerMatcher` agent (or scoring function) ranks the shortlist with rationale → persisted `match_result` rows for auditability. Start with deterministic scoring + optional LLM re-rank on the top N to bound cost.

*Alternative considered*: pure LLM matching over the whole catalog. Rejected — cost and non-determinism at 200+ profiles; SQL prefilter is cheap and explainable.

### D7: Agency safety profile inverts CustDev, scoped to the type
`SafetyFilter` keeps its mechanism but reads `forbidden_topics`/`allow_links`/`max_length` from the campaign type's `safety_profile`, not a global default. The agency profile *allows* "реклама/интеграция/прайс/охваты", still blocks: guarantees of results, fabricated client specifics, sending money/links before operator confirmation, and pressure tactics. Price/commitment intents (`wants_to_schedule` analog → `discusses_price`, `sends_quote`) force `operator_now` so a human confirms commercial terms. CLAUDE.md #7 is reworded: "don't let a campaign drift outside its declared type's framing/safety profile."

## Risks / Trade-offs

- **[Relaxing the global "no ad-sales" invariant could leak into CustDev campaigns]** → Safety vocabulary becomes strictly type-scoped; CustDev type keeps the exact current `forbidden_topics`; add a regression test asserting CustDev campaigns still block ad lexicon after the registry refactor.
- **[Builder ships bad prompts that pass thin fixtures]** → Builder never auto-publishes; operator reviews + the agency type defaults to `assisted` (no auto-send) until promoted; test results shown inline with token/cost.
- **[Posing as an agency with a fictitious client raises trust/ethics/ban risk]** → Treat as operator-supervised: agency dialogues default `assisted`, price/quote intents force handoff; per-account rate limits and existing FloodGuard unchanged; keep raw transcripts for audit.
- **[Migration relaxing mandatory AJTBD could orphan gate logic]** → Backfill creates the `custdev` type and moves each campaign's `ajtbd` into `campaign.goal`; gate reads goal-from-type; a data check asserts every existing campaign has `type_id` + non-null `goal` post-migration.
- **[S3 unavailable in dev/CI]** → `packages/storage` behind a flag; missing S3 logs a warning and degrades media to skipped rather than failing the listener; integration tests use MinIO from compose.
- **[Scope is large (8 spec files, new tables, new agents, UI)]** → Sequence as milestones (registry → builder → agency type → profile/S3 → matching), each gated by a Codex review before the next; sub-agents fan out independent slices (DB, agents, API, web).

## Migration Plan

1. Migration `6_campaign_types`: create `campaign_type`, `blogger_profile`, `profile_data_point`, `media_asset`, `ad_brief`, `match_result`; add `campaign.type_id` (nullable first), `campaign.goal` JSONB.
2. Backfill: insert `custdev` and `agency_sourcing` types (seed agent sets); for each existing campaign set `type_id = custdev` and `goal = { ...ajtbd }`; verify non-null.
3. Flip `campaign.type_id` to NOT NULL in a follow-up migration once backfill verified; `ajtbd` column retained (read-only) one release for rollback, then dropped.
4. Seed `agent_config` for new agency/builder/matcher agents (idempotent seed bump).
5. Rollout behind flags: `campaign_types`, `agency_sourcing`, `object_storage`, `blogger_matching` — enable in order.
6. Rollback: flags off restores CustDev-only behavior; `ajtbd` column still present until step 3's drop, so a single-release rollback is data-safe.

## Open Questions

- Builder model-selection: seed a fixed capability→model map per endpoint, or let the operator pick the "strength budget" per type? (Leaning: seed map + operator override.)
- Matching scoring v1: deterministic only, or always LLM re-rank top N? (Leaning: deterministic + optional re-rank flag.)
- Profile freshness: do rate cards/reach expire (e.g. re-confirm after N months)? Out of scope for v1 but the schema should carry `captured_at` per data point.
- Legal/ethical posture of the fictitious-client opening — does product want a real-client-only constraint configurable on the type? (Capture as a `safety_profile` toggle.)
