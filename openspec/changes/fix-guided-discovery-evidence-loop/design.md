## Context

The guided discovery worker (`apps/workers/src/queues/guided-discovery.ts`) runs one synchronous pass: plan → search → normalize → create/reuse `Channel` → `scrapeQueue.add` → review. For newly created channels the scrape has not run by the time the reviewer is invoked in the same pass, so `hasData=false` and the candidate is skipped with "awaiting scrape — no public evidence yet". Nothing re-reviews after the scrape lands (`channel-scrape.ts` only chains `contact-extract`), and the `scrape_refresh` operator action never re-scores. There is also no action to move a reviewed/shortlisted candidate into the downstream outreach pipeline.

Relevant existing pieces this design reuses (do not reinvent):

- **Atomic-claim + staleness pattern.** `guided-discovery.ts` already claims a run with `updateMany({ where: { id, OR: [{status:'pending'}, {status:'running', updatedAt:{lt: staleBefore}}] } })` and renews the lock via `@updatedAt` on every `persist()`. The review step reuses the same pattern for per-candidate work and run completion.
- **Trace + summary + persist helpers.** `addTrace(...)` writes a sanitized `DiscoveryTraceEventZ`; `persist(extra)` writes `trace`/`summary`/`plannedQueries`. The review step recreates the same minimal helpers over the run row.
- **Reviewer agent.** `blogger_discovery_reviewer` (seeded, `agent_run`-accounted, via `getRunner().run`). Reused as-is for per-candidate scoring.
- **Downstream "into work" path** (the launch bridge): `campaignsService.addContacts(campaignId, contactIds)` (`apps/api/src/services/campaigns.ts:263`) tags contacts into the campaign, upserts a `Conversation` per TG-reachable contact, dedupes existing openers via `OPENER_AGENT_NAMES`, and enqueues `outreach_first_message` agent-run jobs that post a **pending** opener `Suggestion`. The opener is NOT auto-sent — the operator approves it. This is exactly the human-approval-gated entry the launch action must reuse.

Constraints (from CLAUDE.md and the task): zod at boundaries; routes call services / existing queue patterns only; `AppError`/`Errors`; pino redaction; UTC; `agent_run` accounting via the runner; prompts in `agent_config` (fallback only); TS strict + `noUncheckedIndexedAccess`. DB schema change → Prisma migration mirroring `8_guided_discovery_runs`. NEVER touch `packages/platforms/src/index.ts` or `openspec/specs/runtime-feature-flags/spec.md`.

## Goals / Non-Goals

**Goals:**
- A fresh-niche run produces evidence-backed reviews with recommendations (not `reviewed=0`).
- `scrape_refresh` and a never-arriving scrape both resolve to a definite candidate outcome.
- The run never shows green `done` while candidates are still awaiting review.
- An operator can launch a chosen blogger into the existing agency-sourcing outreach pipeline, gated and human-approval-bound.

**Non-Goals:**
- Planner `negativeTerms`/`signal` into search (would touch `packages/platforms`).
- AJTBD sub-scores, feedback learning, pipeline-dedup badges.
- Auto-sending outreach on launch.

## Decisions

### D1. Run status state machine

Add a non-terminal `enriching` state. Transitions:

```
pending ──claim──► running ──phase-1 work──►
    ├─ (review loop still open)  ──► enriching   (non-terminal, polled)
    └─ (everything reviewable was reviewed inline) ──► done
enriching ──per-candidate review closes last open candidate──► done
enriching ──sweep finds no work + no open candidates──► done
(any phase) fatal error / planner empty / integration missing ──► failed
```

- `running` stays the transient "phase-1 in progress" state (unchanged claim semantics).
- After phase 1, the worker computes `pendingReview = candidates with enrichmentStatus ∈ {new, needs_scrape, pending_enrichment} AND review IS NULL AND not budget-skipped`. If `pendingReview > 0` → `enriching`; else → `done`.
- `enriching` and `running` are both pollable (web `pollInterval` already polls unless `done|failed`; we extend the guard to treat `enriching` as live — it already does, since it only stops on `done`/`failed`).

`GuidedRunStatusEnumZ` gains `enriching`; the Prisma `discovery_run_status` enum gains `enriching` via migration `9a_guided_discovery_enriching` (additive `ALTER TYPE ... ADD VALUE`).

**Cancellation is explicitly OUT OF SCOPE for this change.** The current feature exposes no run-abort/cancel control in the UI or API (verified: `discovery-guided.ts` has create/get/list/candidateAction only — no cancel), so there is no path that would leave a run wedged via cancellation. The state set stays `pending | running | enriching | done | failed`; no `cancelled` state is added here. The bounded enrichment deadline (D5) already guarantees an `enriching` run terminates without operator intervention, so "stuck enriching" cannot persist indefinitely even absent a cancel control. If a future change adds operator abort, it MUST introduce a `cancelled` state whose entry stops the hook/sweep from enqueuing further review jobs and does NOT transition to `done`; that work is deferred and called out as a non-goal here so implementers do not improvise a cancel path.

### D2. Phase 1 — evidence-first, no premature skip

`guided-discovery.ts` keeps plan → search → normalize → create/reuse `Channel` → enqueue scrape. The review block changes:

- For each `work` candidate, classify:
  - `alreadyKnown` AND has evidence (`status='scraped' || posts>0 || title || description`) → **review inline now** (within `maxReviewed` budget), exactly as today. This preserves the "known channel reviewed immediately" behavior.
  - otherwise (new channel still scraping, or known-but-empty) → leave `enrichmentStatus` as `needs_scrape`/`pending_enrichment`, do NOT skip-and-forget; it will be reviewed by the scrape→review hook.
- Track `reviewedInline` against `maxReviewed`. Candidates beyond budget are marked budget-skipped (a stable marker, e.g. `review = { skipped: 'budget' }` or a dedicated `enrichmentStatus`/decision note) so the completion check does not count them as pending.
- Set status: `pendingReview>0 → enriching` else `done`. Persist `summary.pendingReview`.

Budget accounting is shared across phase-1 inline reviews AND hook reviews: the per-run `maxReviewed` budget is recomputed from persisted state (count of candidates with non-null `review` that are not budget-skips) at each review attempt, so concurrent scrape-hook jobs cannot collectively exceed the budget. The check is done inside the same atomic-claim window as the completion check (D4).

### D3. `channel-scrape` → guided review hook

**Where the hook fires (final-failure semantics, not per-attempt).** `channel-scrape.ts` (verified) does the work inside a `try`; the `catch` block (lines 150-160) sets `channel.status='failed'` then `throw err`, so the job is RE-TRIED by BullMQ when `attempts > 1`. If the hook fired inside that catch and recorded the candidate as insufficient-evidence, a subsequent successful retry would scrape the channel but the candidate would already be terminal. To avoid this:

- **Success hook** fires inline at the end of the success branch (after `contact-extract` is enqueued), only when the channel actually reached `scraped`.
- **Failure hook** fires ONLY on BullMQ FINAL failure — bound to the worker `'failed'` event (which already exists in `channel-scrape.ts` at line 166), gated on `job.attemptsMade >= (job.opts.attempts ?? 1)` so it runs once, after retries are exhausted. It does NOT fire from the per-attempt `catch`.
- Discovery-originated scrapes are enqueued with `attempts: 1` (see D8 / tasks) so "final failure" == "first failure" for the discovery path and the candidate is unblocked promptly; ad-hoc scrapes that use more attempts still only trigger the failure hook once, after the last attempt.

Candidate lookup (run by BOTH success and final-failure hooks):

```
const openCandidates = await prisma.discoveryRunCandidate.findMany({
  where: {
    channelId,
    run: { status: { in: ['running','enriching'] } },
    OR: [{ review: { equals: Prisma.JsonNull } }, { enrichmentStatus: 'pending_enrichment' }],
  },
  select: { id: true, runId: true },
});
for (const c of openCandidates) {
  await reviewQueue.add(
    'review',
    { runId: c.runId, candidateId: c.id, scrapeOutcome: scrapeOk ? 'ok' : 'failed' },
    // Deterministic jobId so BullMQ dedupes duplicate hook fires at enqueue
    // time. `generation` increments on each scrape_refresh so a refresh
    // produces a NEW review job rather than being swallowed as a duplicate
    // of the prior review.
    { jobId: `review:discovery:${c.runId}-${c.id}-${candidateGeneration}`, attempts: 1 },
  );
}
```

- **`review: null` alone is NOT a sufficient selector.** A candidate that was already reviewed (even as insufficient-evidence) and is then `scrape_refresh`-ed has a non-null `review` and would be skipped by a `review: null`-only filter, so its stale score/evidence would persist forever (BUG #2 partial). The selector therefore also includes `enrichmentStatus = 'pending_enrichment'`: `scrape_refresh` sets `pending_enrichment` (D6), which re-arms the candidate for the hook even though `review` is non-null. The review step (D4) clears the stale `review`/`score`/`recommendation` before re-scoring (see D4 step 0). This is what makes a *re-scrape of an already-reviewed candidate* actually re-score.
- **Deterministic `jobId` for enqueue-time dedup.** `review:discovery:<runId>-<candidateId>-<generation>` ensures BullMQ collapses duplicate hook fires (e.g. success hook + a racing sweep, or two scrape jobs) into one job, removing the "two jobs both observe `review=null` and both spend reviewer tokens" cost regression at the source. `generation` is the candidate's scrape-refresh counter (D6) so a deliberate refresh is a distinct job, not a swallowed duplicate.
- `contact-extract` chaining and all existing scrape behavior are untouched; the hook is additive and best-effort (its failure is logged, never fails the scrape job).
- The `scrapeOutcome` lets the review step record "insufficient evidence — scrape failed" rather than calling the LLM with no data.
- This is the recovery path that fixes BUG #2 and makes `scrape_refresh` (which re-enqueues `channel-scrape`) actually re-score.

The hook uses a `DiscoveryRunCandidate.channelId` lookup. `channelId` is a plain reference (no FK) — already the case — so the `findMany` is the join. We add an index `@@index([channelId])` on `DiscoveryRunCandidate` in the same migration to keep this lookup cheap (additive).

### D4. `guided-discovery-review` step — per-candidate review + completion

New worker `apps/workers/src/queues/guided-discovery-review.ts`, queue `guided-discovery-review`, job `{ runId, candidateId, scrapeOutcome }` (zod: `GuidedDiscoveryReviewJobZ`). Concurrency 1 per run via BullMQ; idempotent.

Per job:
0. **Atomic candidate claim BEFORE any LLM work.** The soft "already has `review` → no-op" guard alone is insufficient: two jobs (e.g. a duplicate hook fire that escaped jobId dedup, or a sweep racing a real review) can both read `review=null`, both proceed, and both spend reviewer tokens (cost regression). So the FIRST DB write per job is an atomic claim:
   ```
   const claim = await prisma.discoveryRunCandidate.updateMany({
     where: { id: candidateId, reviewClaimedAt: null },
     data: { reviewClaimedAt: new Date() },
   });
   if (claim.count === 0) return; // already claimed by another job → no-op, no LLM
   ```
   `reviewClaimedAt` is a new nullable `DateTime` column on `DiscoveryRunCandidate` (additive, in migration `9a`). Only the job that wins the claim calls the LLM; the loser exits before any reviewer token is spent. `scrape_refresh` (D6) clears `reviewClaimedAt` back to `null` (step 0 below) so a deliberate refresh can re-claim and re-review. Combined with the deterministic `jobId` (D3), this gives two layers: enqueue-time dedup (BullMQ jobId) AND a DB-level atomic claim that holds even if dedup is bypassed.
1. Load run + candidate. If run terminal (`done`/`failed`) → no-op. If candidate already has `review` AND is not re-armed for refresh (`enrichmentStatus !== 'pending_enrichment'`) → no-op (idempotent; handles duplicate hook fires and retries). On a refresh re-review, FIRST clear the stale `review`/`score`/`recommendation` (set to null) so the prior result cannot leak through if the new review fails to write all fields.
2. Renew the run lock (touch `updatedAt`) so the run is not considered stale mid-review.
3. Budget check (D2): if reviewed count ≥ `maxReviewed` → mark candidate budget-skipped, trace, go to step 6.
4. If `scrapeOutcome==='failed'` OR still no evidence → persist `review` with `insufficientEvidenceReason` (no LLM call) and `enrichmentStatus='needs_scrape'`/`pending_enrichment`. This is a terminal review outcome for completion purposes (candidate is no longer "pending"), but the operator can still `scrape_refresh`.
5. Else load public evidence (channel metadata + recent posts + profile, same shape as phase-1) and call `blogger_discovery_reviewer` via `getRunner().run` (with `campaignId`/`channelId` ctx for `agent_run` attribution). Persist `score`/`recommendation`/`review`/`enrichmentStatus='enriched'`; trace `review.completed` (+ `candidate.recommended` when `strong_fit`/`possible_fit`). Update `summary.candidatesReviewed`/`recommended`.
6. **Completion check** (inside an atomic guard): recompute `pendingReview` from persisted candidate rows. If `pendingReview===0`, transition `enriching → done` with `completedAt` via `updateMany({ where: { id, status: 'enriching' }, data: { status:'done', completedAt } })` (count-1 wins; losers no-op). Persist updated `summary`.

### D5. Bounded fallback — a never-arriving scrape cannot wedge the run

Two guards so a lost scrape (channel stuck `scraping`/`failed` with no hook, or a dropped review job) does not pin a run in `enriching` forever:

- **Sweep job.** When phase 1 ends in `enriching`, enqueue a delayed `guided-discovery-review` sweep job `{ runId, sweep: true }` at `RUN_ENRICH_DEADLINE_MS` (e.g. 15 min, configurable). The sweep: for each still-open candidate, force a terminal review outcome (`insufficientEvidenceReason='scrape did not complete in time'`), then run the completion check → `done`. Re-arm once if a later scrape hook is still expected within budget? No — single bounded deadline keeps it simple; operators can `scrape_refresh` post-`done` (see D6).
- **Idempotent completion.** Because completion uses `updateMany({ where: { status:'enriching' } })`, the sweep and the last real review racing both resolve to exactly one `done`.

`RUN_ENRICH_DEADLINE_MS` is a worker constant (documented), not a DB field — no schema cost.

### D6. `scrape_refresh` — re-arm the candidate so the re-scrape re-scores

`scrape_refresh` must explicitly RESET the candidate's review state so the post-scrape hook (D3) and review step (D4) treat it as work again — otherwise an already-reviewed candidate keeps its stale `review`/`score`/`recommendation` forever. `candidateAction('scrape_refresh')` therefore, atomically before re-enqueuing the scrape:

- sets `enrichmentStatus = 'pending_enrichment'` (this is the re-arm flag the D3 selector matches even when `review` is non-null),
- sets `reviewClaimedAt = null` (so the review step can re-claim — D4 step 0),
- bumps a per-candidate refresh `generation` counter (used in the deterministic review `jobId`, D3, so the new review job is distinct rather than a swallowed BullMQ duplicate). The counter is stored in the candidate's `provenance` JSON (`provenance.scrapeGeneration`, additive — no new column needed) and read back when the hook builds the jobId.

It does NOT pre-clear `review`/`score`/`recommendation` at refresh time (the operator should keep seeing the prior recommendation until the new one lands); the review step (D4 step 1) clears them only at the moment it begins the re-review. If the new scrape fails, the candidate falls to insufficient-evidence cleanly rather than showing a stale strong-fit.

The scrape hook (D3) only re-reviews candidates whose run is `running|enriching`. To let an operator refresh a candidate on an already-`done` run, `scrape_refresh` also transitions the run back to `enriching` (from `done`) when it re-enqueues, so the hook will fire and the completion check will return it to `done`. (A `failed` run is left as-is — refresh is not offered there.) This keeps the button alive across the run lifecycle and guarantees a re-scrape always re-scores.

### D7. Launch-into-work bridge — REUSE the existing path

**Discovered existing path.** `campaignsService.addContacts(campaignId, contactIds)` is the single entry the product already uses to put a channel's contacts into a campaign and prepare outreach:
- tags each contact with `cmp:<id>` and adds the tag to the campaign `targetFilter`;
- for `reachability='reachable_tg'` contacts, upserts a `Conversation` (`tgAccountId+contactId` unique) bound to the campaign and `defaultMode`;
- dedupes existing openers via `agentName ∈ OPENER_AGENT_NAMES`;
- enqueues `outreach_first_message` agent-run jobs (`jobId: outreach_first_message-<convId>`, idempotent) which post a **pending** opener `Suggestion`. (Dash-joined: a 2-part colon jobId `outreach_first_message:<convId>` is rejected by BullMQ — a colon jobId must split into exactly 3 parts.)

**BLOCKER — `addContacts` can auto-send the opener; launch MUST force a non-sending mode.** Verified in `auto-approve.ts:116-147`: in `semi_auto` mode an opener (no gate, `first_touch` phase) is auto-sent when only the SafetyFilter score clears `T_SAFETY` — there is NO goal-fit gate on the opener path for semi_auto. And in `auto` mode, `first_touch` openers ARE allowed without a gate (`ctx.phase==='first_touch'` bypasses the "refuse without gate" guard at line 136). `addContacts` (verified `campaigns.ts:333,339`) creates/updates the conversation with `mode: c.defaultMode`. So if the launch campaign's `defaultMode ∈ {semi_auto, auto}`, the opener generated by `outreach_first_message` would be AUTO-SENT — directly violating this change's "NO message is auto-sent on launch" requirement and `agency_sourcing`'s human-approval gate.

**Fix (mandatory): launch forces the conversation into a non-sending mode and does not depend on `defaultMode`.** The launch action MUST NOT trust the campaign's `defaultMode`. Two acceptable implementations; this design picks (A):

- **(A) `prepareOnly` option on `addContacts` (chosen).** Extend `campaignsService.addContacts(id, contactIds, opts?: { prepareOnly?: boolean })`. When `prepareOnly` is set, the conversation is upserted with `mode: 'manual'` regardless of `c.defaultMode` (both the `create` and `update` branches at `campaigns.ts:331-341`), and the `outreach_first_message` opener it enqueues lands as a `pending` suggestion that `tryAutoApprove` will refuse (manual → `return false` at `auto-approve.ts:127`). The launch action always passes `prepareOnly: true`. Existing `addContacts` callers (operator manually adding contacts to a running campaign) are unaffected — the new arg defaults to off, preserving today's behavior.
- (B) alternative, if (A) is rejected in review: have the launch action set the conversation `mode='manual'`/`'assisted'` immediately after `addContacts` returns, before the opener job can run. (A) is preferred because it closes the race at the source (the conversation is never momentarily in an auto-send mode) and keeps the gate inside the service rather than racing the worker.

This constraint is also written into the spec delta (the launch requirement now states the conversation is prepared in a non-sending mode and the opener is `pending`) and into the launch task so the implementer wires `prepareOnly` rather than relying on campaign settings.

"Launch into work" therefore means: select the candidate's business/ad contacts → call `addContacts(..., { prepareOnly: true })` → conversation upserted in `manual` mode → `outreach_first_message` posts a `pending` opener → the operator approves it. No new sending path, no new conversation logic, and no dependency on the campaign's auto-approve settings.

**New candidate action `launch`** (`CandidateActionZ` gains `launch`; body carries `{ action: 'launch', campaignId }`). **`campaignId` contract:** it is OPTIONAL in the request body and defaults to the run's `campaignId` when omitted. `CandidateActionZ` does NOT mark it required for `launch`; instead the service resolves `campaignId ?? run.campaignId` and returns `Errors.badRequest('launch requires a campaign — run has none, pass campaignId')` when both are absent. (This supersedes the earlier "required for launch" phrasing; the schema and the service now agree — optional in schema, resolved-or-error in the service.) `discoveryGuidedService.candidateAction` for `launch`:
1. Gates: `channel_discovery` (route preHandler already enforces) + admin/operator role (route). Service resolves the target campaign (`campaignId ?? run.campaignId`), requires it to exist, and — when its `type.key==='agency_sourcing'` — requires the `agency_sourcing` flag on, else `AppError('AGENCY_SOURCING_DISABLED', 422)` (mirrors `campaigns.ts:50`).
2. Candidate must have a linked `channelId`; else `Errors.badRequest('candidate has no linked channel')`.
3. Select **business/ad contacts only**: `prisma.contact.findMany({ where: { channelId, roleGuess: { in: ['ad_manager','owner'] } } })`. **Product decision (documented, not a guess):** eligibility is restricted to roles `ad_manager` and `owner` only. `generic` is EXCLUDED even though it can denote a legitimate published business handle, because at automated-launch scale CLAUDE.md rule 2 requires contacts to be explicitly marked business/ad/manager; a `generic` handle has not cleared that bar without manual review. An operator who judges a `generic` contact legitimate can add it to the campaign manually from the channel view (the normal, human-in-the-loop `addContacts` path) — launch deliberately does not auto-include it. (`bot`/`unknown` are likewise excluded.) If no eligible contact → `Errors.badRequest('no business/ad contact for this channel — run scrape/contact-extract first')` (the operator can `scrape_refresh`, which now chains `contact-extract`).
4. Call `campaignsService.addContacts(campaignId, contactIds, { prepareOnly: true })` and persist launch provenance. Return the `addContacts` summary (chatsCreated/suggestionsQueued/blocker) so the UI can show what happened.

**Launch provenance storage (new column, not `review`).** Verified `DiscoveryRunCandidate` (`schema.prisma:710`) has `review` (Json?) and `decision` (String?) but NO `meta` column. Storing the launch campaign id inside `review` would clobber reviewer output on any subsequent re-review (D4 rewrites `review`). So migration `9a` adds a dedicated nullable `launchedCampaignId String?` column. On launch the action sets `decision='launched'` (additive `CandidateDecisionZ` value) AND `launchedCampaignId=<campaignId>`. `review` is never used for provenance.

**Human-approval guarantee.** `addContacts(..., { prepareOnly: true })` upserts the conversation in `manual` mode and only enqueues `outreach_first_message`, which writes a `pending` `Suggestion`; `tryAutoApprove` refuses for `manual` mode. The launch action does NOT approve or send. So "launch into work" = prepare work for operator approval, never auto-outreach — satisfying CLAUDE.md rules 1, 2, 9 and the `agency_sourcing` default human-approval gate, independent of the campaign's `defaultMode`.

`CandidateDecisionZ` gains `launched` (additive). The web shows a "Запустить в работу" button on candidates with `decision ∈ {saved, shortlisted}` and a linked channel; it requires the operator to pick a campaign (reuse the existing campaign picker pattern), defaulting to the run's campaign.

### D8. Where the code lives (no architecture drift)

- Schemas/enums: `packages/shared/src/schemas/discovery.ts` (status, summary, decision, action), `packages/shared/src/schemas/queue.ts` (`QueueNames.guidedDiscoveryReview`, `GuidedDiscoveryReviewJobZ`).
- Workers: `guided-discovery.ts` (phase-1 split), new `guided-discovery-review.ts`, `channel-scrape.ts` (hook). **Queue registration lives in `apps/api/src/queues.ts`** (the shared queue factory `getQueues()` — verified: there is NO `apps/workers/src/queues.ts`; the workers package imports the factory). The new `guided-discovery-review` queue is added to `apps/api/src/queues.ts`, and the WORKER (consumer) is started in `apps/workers/src/index.ts`. Discovery-originated scrape enqueues (`guided-discovery.ts` and `discovery-guided.ts`'s `scrape_refresh`) pass `attempts: 1` so the D3 final-failure hook fires promptly.
- API: `apps/api/src/services/discovery-guided.ts` (`launch` + `scrape_refresh` re-review), reuse `campaignsService.addContacts(..., { prepareOnly: true })`. `apps/api/src/routes/discovery.ts` audit. Routes still don't touch Prisma/queues beyond the existing service-level pattern.
- DB: migration `packages/db/prisma/migrations/9a_guided_discovery_enriching` — `ALTER TYPE "discovery_run_status" ADD VALUE 'enriching'`; `CREATE INDEX ... ON "discovery_run_candidate"("channel_id")`; add nullable `review_claimed_at` (DateTime) and `launched_campaign_id` (String) columns to `discovery_run_candidate`. All additive.
- Web: `DiscoveryGuidedRunPage.vue`, `helpers.ts`, `types.ts`.

## Risks / Trade-offs

- **[Duplicate review jobs / reviewer cost regression]** Scrape hook + sweep + `scrape_refresh` can enqueue several review jobs for one candidate, risking two jobs both spending reviewer tokens. → THREE layers: (1) deterministic BullMQ `jobId` `review:discovery:<runId>-<candidateId>-<generation>` dedups at enqueue time (D3); (2) DB-level atomic claim `updateMany({ where:{ id, reviewClaimedAt:null }, data:{ reviewClaimedAt } })` before any LLM call — the loser exits with zero tokens spent (D4 step 0); (3) `updateMany`-gated completion. Soft "already reviewed" is no longer the only guard.
- **[Budget under concurrency]** Multiple scrape hooks reviewing in parallel could exceed `maxReviewed`. → Budget recomputed from persisted state at each attempt inside the per-candidate flow; concurrency-1 per queue plus the recompute bounds it (a small overshoot is acceptable but the recompute prevents it).
- **[Stuck `enriching`]** A lost scrape with no hook fire. → D5 delayed sweep forces terminal outcomes at a bounded deadline; completion is idempotent.
- **[Scrape retry vs premature terminal candidate]** A failing scrape that BullMQ will retry must not terminally mark the candidate before the retry. → Failure hook is bound to the BullMQ FINAL `'failed'` event (D3), not the per-attempt `catch`, and discovery scrapes use `attempts: 1`.
- **[Launch auto-send]** `addContacts` honours `campaign.defaultMode`, which can be `semi_auto`/`auto` and would auto-send the opener. → Launch passes `prepareOnly: true`, forcing `mode: 'manual'` on the conversation so the opener stays a `pending` suggestion (D7). Launch never trusts `defaultMode`.
- **[Re-scrape of an already-reviewed candidate]** A `review: null`-only hook selector would skip a previously-reviewed candidate on `scrape_refresh`, leaving stale evidence forever. → Hook selector also matches `enrichmentStatus='pending_enrichment'` (set by refresh), and the review step clears the stale `review` before re-scoring (D3/D6).
- **[Cancellation]** No run-abort exists today; adding `enriching` does not introduce a wedge because the bounded sweep always terminates. A future cancel control must add a `cancelled` state (D1) — deferred, explicitly out of scope here.
- **[Launch with no business contact]** Fresh channel may have no `ad_manager`/`owner` contact yet. → Explicit `badRequest` telling the operator to scrape/extract first; `scrape_refresh` now chains `contact-extract`. No silent personal-contact fallback (rule 2).
- **[`done`→`enriching` reopen on refresh]** Reopening a terminal run could surprise the UI. → It is a deliberate, audited transition; the poll re-activates while `enriching` and returns to `done` on completion.

## Migration Plan

1. **Phase A — schema + shared.** Migration `9a`: `enriching` enum value, `discovery_run_candidate.channel_id` index, nullable `review_claimed_at` + `launched_campaign_id` columns. Shared: `pendingReview`, `launched` decision, `launch` action, review queue + job schema. Backward compatible (all additive).
2. **Phase B — review loop.** Phase-1 split, `guided-discovery-review` worker, scrape hook, sweep. Behind `channel_discovery` (already gates creation). Existing `done`/`failed` rows unaffected.
3. **Phase C — launch bridge.** `launch` action reusing `addContacts`; web button + campaign picker. Gated; human-approval-bound.
4. **Rollback.** Phase B/C are additive behind the existing flag; reverting the worker registration restores prior single-pass behavior (runs would again finish `done` with the old skip semantics). No data migration to undo (enum value can stay).

## Open Questions

1. **`RUN_ENRICH_DEADLINE_MS` default** — 15 min proposed. Should it scale with `maxCandidates`? Default fixed for now.
2. **Reviewer "scrape failed" prompt** — D4 step 4 records insufficient-evidence WITHOUT an LLM call (cheaper, deterministic). If product wants the reviewer to still emit a rationale on failure, adjust the seed prompt + add a unit test. Default: no LLM call on failure.

The following were open questions in the first draft and are now DECIDED (Codex review):
- **Launch campaign target** — DECIDED: `campaignId` is optional in the request and defaults to the run's `campaignId`; the service errors if both are absent (D7). Schema and service agree.
- **Eligible launch roles** — DECIDED: `ad_manager` + `owner` only. `generic`/`bot`/`unknown` excluded; operators add `generic` contacts manually if warranted (D7, rule 2).
- **Cancellation** — DECIDED: out of scope; no `cancelled` state in this change (D1).
