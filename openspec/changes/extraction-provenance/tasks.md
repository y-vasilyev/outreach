## 1. Schema

- [ ] 1.1 Prisma: `profile_data_point.agent_run_id String?` + `superseded_at DateTime?`; partial index `(profile_id, field) WHERE superseded_at IS NULL`; migration `9h_extraction_provenance` (verify lexical order after `9g_*`)
- [ ] 1.2 Shared schemas: expose `agentRunId`/`supersededAt` on data-point types; document `placement_attribute.status` value `superseded`

## 2. Run-id threading

- [ ] 2.1 `AgentRunner.persistRun()` persists `id: runId` (log id == row id); `AgentRunner.run()`/`runAgentSafe` return `{ output, runId }` with `runId=null` when run persistence failed; update all call sites (typecheck-driven sweep)
- [ ] 2.2 `profile-extract.ts`: stamp per-extractor `agentRunId` on persisted drafts; wire `PlacementAttribute.proposedByRunId` from the same run
- [ ] 2.3 Unit/integration test: rate vs audience points carry their respective run ids; operator-origin points keep null

## 3. Soft supersede

- [ ] 3.1 Supersede block: `deleteMany` → `updateMany({...supersededAt: null}, {supersededAt: now})` for data points; `proposed` attribute rows → status `superseded`; `raw_payload` media-asset replacement unchanged
- [ ] 3.2 Grep-backed checklist: enumerate EVERY `profileDataPoint.findMany/findFirst` and `dataPoints` include (known: profile-extract roll-up load, idempotency `findFirst`, `operator-markup.ts`, `agent-run.ts` planner inputs, `blogger-profiles.ts` detail, rollup loaders, HUD `buildHudTargetRow`); route all through a shared live-rows helper defaulting `supersededAt: null`; checklist attached to the PR
- [ ] 3.3 Integration tests: re-run supersedes old + writes new + third delivery no-op; HUD/roll-up identical to delete-based behavior; operator points and `active` attributes untouched

## 4. History read path

- [ ] 4.1 `GET /blogger-profiles/:id?includeSuperseded=true`: returns superseded points with `supersededAt`/`agentRunId`; default response byte-identical (regression test)
- [ ] 4.2 Attribute review UI: collapsed history section for `superseded` proposals, non-actionable

## 5. Docs & rollout

- [ ] 5.1 `DESIGN.md` provenance chain (message → agent_run → fact → offer → profile); `AGENTS.md` runAgentSafe return shape; `CHANGELOG.md`
- [ ] 5.2 Rollback runbook note: cleanup SQL for rows superseded during a rollback window
- [ ] 5.3 `pnpm typecheck && pnpm lint && pnpm test` green
