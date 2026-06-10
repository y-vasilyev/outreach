## Why

Two audit gaps remain in the fact layer. (1) A `ProfileDataPoint` records *who* (`extractedBy='llm'`) but not *which run* — when an extractor prompt/model changes, old and new facts are indistinguishable, and a wrong fact can't be traced to the `agent_run` (model, config version, tokens) that produced it, even though every LLM call already writes one. (2) Operator re-run with `supersede=true` physically deletes the prior data points, attribute proposals — the system's only record of «что мы считали верным до переразбора» disappears exactly when an operator decided the extraction was wrong, i.e. when the history matters most. `placement-offer-table` fixes this for offer rows; this change fixes the fact layer itself.

## What Changes

- **`agentRunId` on `ProfileDataPoint`.** Plain string reference (no FK, mirroring `sourceMessageId`) filled by the profile-extract worker from the extractor's `agent_run`. Operator-origin points keep it null. `PlacementAttribute.proposedByRunId` — already in the schema but always null — gets wired from the same place.
- **Soft supersede for data points.** `ProfileDataPoint` gains `supersededAt DateTime?`; operator re-run marks prior rows (`updateMany`) instead of `deleteMany`. All default readers — roll-up loaders, HUD target rows, idempotency check, profile read API — exclude superseded rows. The idempotency `findFirst` considers only live rows, so the fresh re-extraction writes are not skipped.
- **Attribute proposals survive re-run.** `placement_attribute` gains status `superseded` (alongside `active|proposed|rejected`); re-run moves the message's `proposed` rows there instead of deleting. Review UI shows them under a collapsed history section.
- **History on demand.** `GET /blogger-profiles/:id` accepts `includeSuperseded=true` (default false → response unchanged) returning superseded points with their `supersededAt` and `agentRunId`, so an operator can audit «что изменил переразбор» without raw SQL.

## Capabilities

### Modified Capabilities

- `blogger-commercial-profile`: the granular data-point contract gains `agent_run_id` provenance and soft-supersede semantics (`superseded_at`), with default readers excluding superseded rows.
- `operator-reanalysis`: re-run with supersede marks rows superseded instead of deleting them (raw-payload media asset replacement unchanged).

## Impact

- **DB migration `9h_extraction_provenance`**: `profile_data_point.agent_run_id` (nullable) + `superseded_at` (nullable) + partial index `(profile_id, field) WHERE superseded_at IS NULL`; no enum change needed for `placement_attribute.status` (plain string column).
- **apps/workers**: `profile-extract.ts` — thread `agentRunId` from extractor runs into drafts; supersede block becomes `updateMany`/status flip; idempotency filter adds `supersededAt: null`.
- **packages/shared**: `profile-rollup.ts` loaders and `data-collection-targets.ts` HUD row builder filter live rows; schemas expose the new fields.
- **packages/agents**: `runAgentSafe`/extractor return surfaces the `agent_run` id (it already exists internally in `AgentRunner`).
- **apps/api**: blogger-profiles read service `includeSuperseded` param; attribute review service/UI handles `superseded` status.
- **apps/web**: attribute review history section; profile data-point audit view can come later (API suffices now).
- **Compatibility**: both columns nullable; default reads unchanged; no behavior change for non-supersede extraction. Storage grows by superseded rows — bounded by operator re-runs, which are rare and intentional.
