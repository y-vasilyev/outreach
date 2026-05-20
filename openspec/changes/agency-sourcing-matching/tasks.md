## 0. Process & sequencing

- [ ] 0.1 Implement in milestone order (sections 1→9); fan out independent slices (DB, agents, API, web) to sub-agents within a milestone
- [ ] 0.2 At each milestone gate (marked **CODEX REVIEW**), run a Codex review of the milestone diff before starting the next milestone; address findings before proceeding
- [x] 0.3 Add feature flags to `packages/shared/src/flags.ts`: `campaign_types`, `agency_sourcing`, `object_storage`, `blogger_matching` (default off)

## 1. DB schema & migration foundation

- [x] 1.1 Add `campaign_type` model to `schema.prisma` (`key`, `name`, `goal_schema` JSONB, `agent_set` JSONB, `safety_profile` JSONB, `autonomy_policy` JSONB, timestamps)
- [x] 1.2 Add `campaign.type_id` FK (nullable initially) and `campaign.goal` JSONB
- [x] 1.3 Add `blogger_profile`, `profile_data_point`, `media_asset`, `ad_brief`, `match_result` models with indexes (profile topic/geo, data_point.profile_id, match_result.brief_id)
- [x] 1.4 Create migration `6_campaign_types` and apply via `pnpm db:migrate`
- [x] 1.5 Backfill migration: insert `custdev` + `agency_sourcing` types; set every existing campaign `type_id = custdev` and move `ajtbd` → `campaign.goal` (scaffold from goalText/valueProp when absent); assert non-null
- [x] 1.6 Add zod schemas in `packages/shared` for `CampaignType`, `BloggerProfile`, `ProfileDataPoint`, `MediaAsset`, `AdBrief`, `MatchResult` + derived types

## 2. Campaign-type registry & pipeline resolution

- [x] 2.1 Service to load a campaign's type (registry lookup) and validate `campaign.goal` against the type's `goal_schema` on campaign create/update
- [x] 2.2 Make `Orchestrator` resolve the pipeline step list + per-agent overrides from the active campaign type instead of hardcoded constants — Orchestrator stays generic; type-driven per-agent overrides (safety profile) + force-handoff resolved in the worker behind `ENABLE_CAMPAIGN_TYPES`; AgentRunner now deep-merges `params`
- [x] 2.3 Make `SafetyFilter` read `forbidden_topics`/`allow_links`/`max_length` from the type's `safety_profile`; keep `custdev` defaults identical to today
- [x] 2.4 Make `on_inbound`/`outreach_first_message`/`followup_check` resolve agents + autonomy policy from the type — on_inbound + outreach wired (safety profile + forceHandoffIntents); followup reuses on_inbound safety path
- [x] 2.5 Campaign-type CRUD routes (`apps/api`) with role checks + audit_log entries
- [x] 2.6 Regression test: CustDev campaigns still block ad-sales vocabulary and run the same agents after the refactor
- [x] 2.7 **CODEX REVIEW** — milestone 1 (registry + CustDev parity). Findings addressed: (B1) flag-off now passes no SafetyFilter overrides/topic vars → byte-for-byte legacy; (B2) `/campaign-types` routes flag-gated + non-custdev `typeId` rejected while flag off; (S1) followup safety wired to type profile; (S2) forced handoff sets `urgency=high`; (N1) AgentSet open-extension documented; (N2) redundant `channelId` index removed. Deferred to M4 (gated unreachable now): (B3) full `agentSet` role→agent resolution + non-custdev `goal`→agent mapping — agency agents/pipeline land in M4 and agency campaigns are flag-gated until then. (S3) migration ships a minimal built-in scaffold; seed.ts is source of truth, consistent with how agent_configs are seeded. (S4 was a false positive — pre-existing uncommitted worker changes, not this diff.)

## 3. Campaign-type builder

- [x] 3.1 Seed a capability→endpoint/model map (cheap/medium/strong) per available endpoint — `DEFAULT_CAPABILITY_MAP` + `resolveCapabilityMap` in `packages/shared/src/capability-map.ts`; seed block in `seed.ts` resolves it against configured endpoints and logs which tiers degrade (no endpoint)
- [x] 3.2 `CampaignTypeBuilder` meta-agent in `packages/agents`: input `{ goal_description, examples?, constraints? }` → draft `goal_schema`, `safety_profile`, per-role draft agent configs (prompts, model tier, params, output schema); register + seed — registered in `agents/index.ts`; seeded as `campaign_type_builder` agent_config (strong tier, rebound from capability map at run time)
- [x] 3.3 Builder runs each drafted agent against fixtures via `dry_run`, attaching output/tokens/cost/latency; report tiers with no available endpoint — `AgentRunner.dryRunConfig` runs an inline (unsaved) config; service attaches per-agent results and skips/reports agents whose tier has no endpoint
- [x] 3.4 Save-draft flow: create `campaign_type` + real `agent_config` rows (v1 in `agent_config_history`); audit the save; never auto-publish — `saveDraft` in `campaign-type-builder.ts` (tx: agent_config v1 + history v1 + campaign_type; audit `campaign_type.build_save`)
- [x] 3.5 API endpoints: build draft, fetch draft results, save draft — `routes/campaign-type-builder.ts` (admin, flag-gated behind ENABLE_CAMPAIGN_TYPES)
- [x] 3.6 Unit tests with mocked `LLMProvider`: draft completeness, no live config before save, model-tier selection — `packages/agents/.../CampaignTypeBuilder.test.ts` + `apps/api/.../campaign-type-builder.test.ts`

## 4. Agency sourcing pipeline & agents

- [x] 4.1 Seed `agency_sourcing` type's `safety_profile` (permits commercial vocabulary; blocks guarantees, fabricated client specifics, money/links, pressure) — `allowed_topics` carry commercial vocab; `forbidden_topics` now carry the agency guardrail tone signals (guarantee/pressure/money phrases) consumed by SafetyFilter as advisory risk signals (`packages/db/prisma/seed.ts`)
- [x] 4.2 `AgencyOpeningComposer` agent (`agency_opening_composer`): opening referencing an observed sponsored integration in the channel's posts; deterministic no-fabrication guard (no observed integration → not auto-send-eligible, cited brand must match a supplied snippet/brand). Registered + seeded
- [x] 4.3 `DataCollectionPlanner` agent (`data_collection_planner`): deterministic missing-set (target − collected), proposes next single missing question, never re-asks collected, authoritative goal-satisfied signal. Registered + seeded
- [x] 4.4 Intent handling: added `discusses_price` + `sends_quote` to IntentClassifier's enum (kept all existing intents); the agency type's seeded `forceHandoffIntents` escalate them. Tests updated
- [x] 4.5 Default `agency_sourcing` conversations to `assisted` (verified in seed `autonomyPolicy.defaultMode='assisted'` + documented); agency `agentSet` points `opening_composer→agency_opening_composer` and adds `data_collection_planner`; pure `resolveAgentName(agentSet, role, fallback)` helper added in `packages/shared` (worker call-site wiring deferred to integration — agent-run.ts not touched per constraints)
- [x] 4.6 Unit tests (mocked LLM): opening cites real ad / refuses fabrication, planner sequencing + stop-when-complete, price intent in classifier output + force-handoff, commercial vocab passes safety low-risk, result-guarantee high-risk, `resolveAgentName` resolution
- [x] 4.7 **CODEX REVIEW** — milestone 2 (builder + agency pipeline). Fixed: (B1) saved builder configs now runnable — AgentRunner resolves impl by `config.role` when the per-type name isn't a registered agent; (S1) agency opener guard also requires the cited integration to appear in the text; (S2) DataCollectionPlanner replaces re-asking reply text with a deterministic question for the corrected field; (S3) dryRun/dryRunConfig try/finally token-acc cleanup; (S4) save audit moved inside the tx; (S5) snake_case key enforced at the builder save boundary; (N1) draft store capped at 200 + oldest-first eviction. Deferred: (B2) worker call-site agentSet resolution (opening/reply→agency agents) + DataCollectionPlanner invocation — to the M5 worker-integration step (needs profile data points + the intermingled agent-run.ts); flag-gated/unreachable until then. (B3) SafetyFilter stays advisory — result-guarantees are "blocked" via high risk_score → fails the auto-send gate → operator-only, the same mechanism CustDev uses for ad-lexicon (per 2.6); reintroducing hard substring blocking would reverse a deliberate prior design decision.

## 5. Blogger commercial profile & extractors

- [ ] 5.1 `RateCardExtractor` + `AudienceStatsExtractor` agents → emit `profile_data_point`s with confidence + `raw_snippet`; write `agent_run`
- [ ] 5.2 Profile-extraction worker queue triggered on agency inbound (and on demand); persists data points
- [ ] 5.3 Deterministic roll-up composing `blogger_profile` standardized fields from data points (latest high-confidence), with `captured_at`
- [ ] 5.4 API: blogger-profile read endpoints (list/detail with data points)
- [ ] 5.5 Tests: rate-card/audience extraction mapping, raw-snippet preservation, low-confidence flagged-not-dropped, deterministic roll-up

## 6. Media asset storage (S3)

- [ ] 6.1 `packages/storage` `ObjectStore` wrapping S3-compatible SDK; `S3_*` env; flag-gated; MinIO in `compose.dev.yml`
- [ ] 6.2 `tg-listen`: on inbound media, download via `tg-client`, put to S3 (`bloggers/{profileId}/{assetId}`), write `media_asset`; degrade-with-warning when storage off
- [ ] 6.3 Snapshot raw reply text + parsed JSON to object storage under deterministic key, referenced from data points
- [ ] 6.4 API: presigned GET (download) and PUT (upload) endpoints; never expose/log credentials (use `redact()`)
- [ ] 6.5 Integration test (MinIO): media persisted + read back via presigned URL; disabled-storage path does not fail inbound

## 7. Blogger matching

- [ ] 7.1 `ad_brief` intake route + zod validation; persist brief
- [ ] 7.2 Deterministic SQL prefilter over `blogger_profile` (topic overlap, geo, format, budget vs rate card) → shortlist
- [ ] 7.3 Deterministic scoring + rationale; persist `match_result` rows linked to brief
- [ ] 7.4 `BloggerMatcher` agent: optional LLM re-rank bounded to top N (configurable); writes `agent_run`; works with re-rank flag off
- [ ] 7.5 API: brief→match endpoint returning ranked candidates with rationale
- [ ] 7.6 Tests: prefilter exclusion, budget-aware ranking, re-rank bounded to top N, deterministic path with LLM off
- [ ] 7.7 **CODEX REVIEW** — milestone 3 (profile + S3 + matching)

## 8. Web UI

- [ ] 8.1 Campaign-type builder UI: goal description input → draft preview with per-agent test results, edit, save
- [ ] 8.2 Campaign settings: select campaign type; type-specific goal editor (AJTBD editor reused for `custdev`, agency goal editor for `agency_sourcing`)
- [ ] 8.3 Blogger catalog list + profile view (standardized fields, data points with provenance, media kit downloads via presigned URLs)
- [ ] 8.4 Brief → match screen: submit brief, show ranked candidates with rationale

## 9. Docs, telemetry & rollout

- [ ] 9.1 Update `DESIGN.md` (new tables, S3, matching) and `AGENTS.md` (new agents + agency pipeline + per-type safety/goal)
- [ ] 9.2 Reword `CLAUDE.md` "Чего не делать #7" to be campaign-type-aware (don't drift outside the type's declared framing/safety)
- [ ] 9.3 Add metrics: `bloggers_profiled_total`, `profile_data_points_total{field}`, `match_requests_total`, builder/extractor agent cost; add to `/metrics`
- [ ] 9.4 Follow-up migration: flip `campaign.type_id` to NOT NULL after backfill verified; retain `ajtbd` column one release then drop
- [ ] 9.5 CHANGELOG.md entry for operator-visible changes
- [ ] 9.6 `pnpm typecheck && pnpm lint && pnpm test` green; **CODEX REVIEW** — final pass over the full change
