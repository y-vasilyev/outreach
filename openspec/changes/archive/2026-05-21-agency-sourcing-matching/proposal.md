## Why

Today the product is hardwired to a single outreach goal — CustDev interviews — with framing, agents, prompts and safety rules ("never sound like ad sales") baked into code. The next business goal is the opposite motion: pose as a media-buying agency, message bloggers off the back of an ad we saw in their post ("we have a client who wants a similar integration"), negotiate price/timelines/formats, and collect their reach and audience stats. The point is to assemble a catalog of ~200 bloggers with standardized commercial profiles so that, when a real ad brief arrives, we can match a relevant blogger instantly.

Doing this without breaking CustDev means the "what is the campaign trying to achieve, and how do its agents behave" decision must move out of code and into a configurable **campaign-type registry**, authored by a **type builder** that turns a plain-language goal into a tested agent set. On top of that we add the agency sourcing flow, a standardized blogger profile (with raw replies and uploaded files preserved in S3), and a matching engine over the resulting catalog.

## What Changes

- **BREAKING**: Campaign goal/framing stops being CustDev-only. A `Campaign` now references a **campaign type** from a registry. CustDev becomes a seeded type; AJTBD becomes that type's goal schema rather than a field mandatory on every campaign.
- Introduce a **campaign-type registry** (справочник): each type declares its conversation goal schema, agent set + per-agent config, safety profile (allowed/forbidden vocabulary), and autonomy/gate policy. Pipelines (`outreach_first_message`, `on_inbound`, gate) resolve behavior from the active type instead of hardcoded CustDev logic.
- Introduce a **campaign-type builder**: an operator describes the campaign goal in plain language; a meta-agent drafts the agent set, picks models, writes prompts, and runs them against test fixtures, producing a draft type for review/edit/save. All produced agents remain UI-editable.
- Add the **agency sourcing campaign type** (seeded): opening that references the blogger's own ad post and a hypothetical client, a data-collection dialogue planner that asks for price/formats/timelines/reach/audience, and a safety profile that *permits* commercial language (the inverse of CustDev's filter).
- Add a **standardized blogger commercial profile**: rate cards per format, reach/views, audience demographics & geo, plus extractor agents that map free-text replies into the standardized shape. Raw replies are preserved verbatim alongside the parsed result.
- Add **media-asset storage in S3**: files bloggers send (media kits, stat screenshots) and raw response payloads are stored in object storage and linked to the conversation and blogger profile for later analysis.
- Add a **blogger matching engine**: an incoming ad brief (topic, audience, budget, format, geo) is matched against the catalog and returns ranked candidate bloggers with rationale.

## Capabilities

### New Capabilities
- `campaign-type-registry`: configurable dictionary of campaign types; each defines goal schema, agent set + config, safety profile, and autonomy policy that drive the pipelines.
- `campaign-type-builder`: meta-agent + flow that turns a plain-language campaign goal into a drafted, model-selected, prompt-written, test-run agent set saved as a campaign type.
- `agency-sourcing-pipeline`: the seeded agency campaign type — agency-framed opening off the blogger's ad, data-collection dialogue, and a commercial-language safety profile.
- `blogger-commercial-profile`: standardized data model for rate cards, reach, audience stats + extractor agents mapping raw replies into it, with raw text preserved.
- `media-asset-storage`: S3-backed storage of uploaded files and raw response payloads, linked to conversations and blogger profiles.
- `blogger-matching`: ad-brief → ranked relevant bloggers query over the catalog with scoring rationale.

### Modified Capabilities
- `campaign-ajtbd-framing`: AJTBD is no longer mandatory on every campaign; it becomes the goal schema of the `custdev` campaign type within the registry. Existing CustDev campaigns keep their AJTBD unchanged.
- `conversation-quality-gate`: `GoalFitEvaluator` evaluates a draft against the active campaign type's goal definition (AJTBD for custdev, data-collection goal for agency), not AJTBD exclusively.

## Impact

- **DB schema** (`packages/db/prisma/schema.prisma`): new `campaign_type`, `blogger_profile`, `profile_data_point`, `media_asset`, `ad_brief`, `match_result` tables; `campaign.type_id` FK; `ajtbd` relaxed to nullable / moved under custdev type. New migration + backfill seeding the `custdev` and `agency_sourcing` types.
- **Agents** (`packages/agents`): new `AgencyOpeningComposer`, `DataCollectionPlanner`, `RateCardExtractor`, `AudienceStatsExtractor`, `BloggerMatcher`, and the `CampaignTypeBuilder` meta-agent; registry + seed entries. Existing agents become type-parameterized via the registry.
- **API** (`apps/api`): campaign-type CRUD + builder endpoints, blogger-profile read endpoints, file-upload/download (S3 presign) endpoints, matching/brief endpoint. New zod schemas in `packages/shared`.
- **Workers** (`apps/workers`): agency pipeline steps, profile-extraction queue, S3 ingest of incoming TG media via `tg-listen`.
- **Web** (`apps/web`): campaign-type builder UI, agency campaign config, blogger catalog + profile view, brief→match screen.
- **Infra/env**: object storage config (`S3_*` env), S3 client dependency.
- **Safety**: the CustDev "never mention ads" invariant becomes type-scoped; the agency type explicitly allows it. CLAUDE.md "Чего не делать #7" must be reworded to be type-aware.
