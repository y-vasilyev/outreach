## 1. Schema

- [x] 1.1 Prisma: `profile_data_point.agent_run_id String?` + `superseded_at DateTime?`; partial index `(profile_id, field) WHERE superseded_at IS NULL`; migration `9h_extraction_provenance` (verify lexical order after `9g_*`)
- [x] 1.2 Shared schemas: expose `agentRunId`/`supersededAt` on data-point types; document `placement_attribute.status` value `superseded`

## 2. Run-id threading

- [x] 2.1 `AgentRunner.persistRun()` persists `id: runId` (log id == row id); NEW `runWithMeta()`/`runAgentSafeWithMeta()` return `{ output, runId }` with `runId=null` on persist failure — additive surface instead of changing every `run()` call site (zero churn across pipelines; run() delegates)
- [x] 2.2 `profile-extract.ts`: stamp per-extractor `agentRunId` on persisted drafts; wire `PlacementAttribute.proposedByRunId` from the same run
- [x] 2.3 Unit/integration test: rate vs audience points carry their respective run ids; operator-origin points keep null

## 3. Soft supersede

- [x] 3.1 Supersede block: `deleteMany` → `updateMany({...supersededAt: null}, {supersededAt: now})` for data points; `proposed` attribute rows → status `superseded`; `raw_payload` media-asset replacement unchanged
- [x] 3.2 Grep-backed checklist: enumerate EVERY `profileDataPoint.findMany/findFirst` and `dataPoints` include (known: profile-extract roll-up load, idempotency `findFirst`, `operator-markup.ts`, `agent-run.ts` planner inputs, `blogger-profiles.ts` detail, rollup loaders, HUD `buildHudTargetRow`); route all through a shared live-rows helper defaulting `supersededAt: null`; checklist attached to the PR
- [x] 3.3 Integration tests: re-run supersedes old + writes new + third delivery no-op; HUD/roll-up identical to delete-based behavior; operator points and `active` attributes untouched

## 4. History read path

- [x] 4.1 `GET /blogger-profiles/:id?includeSuperseded=true`: returns superseded points with `supersededAt`/`agentRunId`; default response byte-identical (regression test)
- [x] 4.2 Attribute review API: `superseded` status + `GET /placement-attributes/proposals?includeSuperseded=true` returns the history list separately (no review UI page exists yet — history exposed via API; UI section when the page lands)

## 5. Docs & rollout

- [x] 5.1 `DESIGN.md` provenance chain (message → agent_run → fact → offer → profile); `AGENTS.md` runAgentSafe return shape; `CHANGELOG.md`
- [x] 5.2 Rollback runbook note: cleanup SQL for rows superseded during a rollback window
- [x] 5.3 `pnpm typecheck && pnpm lint && pnpm test` green
