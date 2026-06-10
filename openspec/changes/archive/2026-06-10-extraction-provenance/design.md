## Context

`profile-extract.ts` runs both extractors via `runAgentSafe`, which (through `AgentRunner`) already persists an `agent_run` per call — but the run id never reaches the written `ProfileDataPoint` rows, and `PlacementAttribute.proposedByRunId` is seeded `null`. The operator re-run supersede block (`profile-extract.ts` write tx) `deleteMany`s prior `(profileId, sourceMessageId)` non-operator points and `proposed` attribute rows. Readers that must keep their current view if supersede goes soft: the idempotency `findFirst` in the same file, `rollUpProfileFields()` input loading, `buildHudTargetRow()` in `data-collection-targets.ts`, and the profile read service's data-point listing.

This is the smallest change of the four — two nullable columns, one status value, and a handful of `WHERE superseded_at IS NULL` filters — but it closes the audit chain end-to-end: message → media/OCR → `agent_run` → fact → offer row → rolled profile.

## Goals / Non-Goals

**Goals:**

- Every LLM-extracted fact links to its `agent_run` (and thus model/config/tokens/cost).
- Operator re-run never destroys information; «до/после переразбора» reconstructible via API.
- Zero behavior change for default reads and non-supersede extraction.

**Non-Goals:**

- No FK constraints (mirrors `sourceMessageId` precedent; `agent_run` retention must stay independently manageable).
- No re-run versioning UI beyond the API param + attribute review history section.
- No change to `raw_payload` media-asset replacement on re-run (the snapshot is regenerated; the prior payload's facts are what we now preserve).
- No retroactive backfill of `agentRunId` for historical rows (unknowable).
- Offer-row lifecycle is `placement-offer-table`'s concern; this change only aligns the fact layer.

## Decisions

### D1. Plain string `agentRunId`, threaded through the draft pipeline

Today `AgentRunner.run()` generates a local `runId = randomUUID()` used only for logging — `persistRun()` lets Prisma generate its own `agent_run.id`, so the logged id matches no row. Fix at the source: `persistRun()` passes `id: runId` into `agentRun.create` (logs and the row become the same id), and `AgentRunner`/`runAgentSafe` surface `{ output, runId }` where `runId` is **null when run persistence failed** (`persistRun` already swallows persistence errors; a fact must never reference a row that was not written). The worker stamps `agentRunId` onto each draft it persists from that extractor's output. Per-extractor, not per-job: rate and audience points get their respective run ids. Alternative — a join via `agent_run.conversationId` + timestamps — rejected: ambiguous with parallel runs and retries; the explicit id is one column.

### D2. `supersededAt` timestamp over a status enum

The data point has no other lifecycle states (low-confidence is expressed via `confidence`; operator origin via `extractedBy`), so a nullable timestamp doubles as flag + audit time. The partial index `(profile_id, field) WHERE superseded_at IS NULL` keeps hot-path reads (roll-up, HUD) on an index of live rows only — cheaper than today's full index for profiles with re-run history.

Re-run flow becomes: `updateMany({ profileId, sourceMessageId, extractedBy: { not: 'operator' }, supersededAt: null }, { supersededAt: now })`. The existing safety property is preserved: it runs after both extractors succeeded, inside the write tx — a failed re-extraction still never loses the old data (now doubly so).

### D3. Idempotency must say «live rows only»

The skip-if-exists `findFirst` adds `supersededAt: null` — otherwise the fresh re-run rows would be skipped as duplicates of the rows just superseded (the exact bug class the original delete avoided). This is the one subtle edit; an integration test pins it: re-run on the same message ⇒ old rows superseded, new rows written, third plain delivery ⇒ no-op.

### D4. `superseded` as a fourth `placement_attribute` status

`status` is a plain string column with values `active|proposed|rejected`; re-run flips the message's `proposed` rows to `superseded` (keeping `evidence`/`rationale`). `active` rows stay untouchable by re-run exactly as today (curated registry). Review UI: `superseded` appears only in a collapsed history list, never actionable. Alternative — reuse `rejected` — rejected: it would conflate «оператор отклонил» with «переразбор заменил», destroying exactly the distinction this change exists to keep.

### D5. History exposure is a read param, not a new endpoint

`includeSuperseded=true` on the existing profile read; superseded points return with `supersededAt` + `agentRunId`. Default response stays byte-identical (regression-pinned). The operator UI need (diff view «до/после») can be built later purely client-side from this.

## Risks / Trade-offs

- [Readers missed in the live-rows sweep would silently include superseded facts] → the sweep is enumerated up front by grep over every `profileDataPoint` read/include and `dataPoints` relation include — known sites beyond roll-up/HUD/idempotency: `profile-extract.ts` roll-up load (~436), `apps/api/src/services/operator-markup.ts` (~22), `apps/workers/src/queues/agent-run.ts` planner inputs (~415), `apps/api/src/services/blogger-profiles.ts` detail include (~466). All go through a shared live-rows query helper defaulting `supersededAt: null`; the checklist lands in tasks and integration tests cover roll-up, HUD, planner inputs, markup, and idempotency after a re-run.
- [Storage growth from kept rows] → bounded by operator re-runs (rare, intentional); partial index keeps reads unaffected.
- [`agent_run` rows may be retention-pruned later, dangling the reference] → same accepted semantics as `sourceMessageId` (plain ref, nullable meaning «unknown/gone»).
- [runAgentSafe signature change touches all call sites] → mechanical; return shape extended, existing destructuring updated in one sweep, typecheck enforces completeness.

## Migration Plan

1. `9h_extraction_provenance`: two nullable columns + partial index (additive, instant; named to sort after `9g_*`).
2. Deploy workers/api/shared together.
3. Verify: re-run a known message on staging → old rows carry `supersededAt`, new rows carry fresh `agentRunId`, HUD/roll-up unchanged, `includeSuperseded` shows both generations.
4. Rollback: revert deploy — columns sit inert; superseded rows created meanwhile stay excluded by... nothing (old code ignores the column), so post-rollback the old code would re-include them in reads. Mitigation: rollback also reverts supersede to delete-on-rerun, and any rows superseded during the window can be cleaned with one SQL statement documented in the runbook (`DELETE ... WHERE superseded_at IS NOT NULL` — matching exactly what the old code would have deleted). Acceptable for the short rollback window.

## Open Questions

- None blocking.
