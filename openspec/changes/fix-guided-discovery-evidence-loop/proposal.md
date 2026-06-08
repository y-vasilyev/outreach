## Why

AJTBD-guided blogger discovery (commit `bf49296`, flag `channel_discovery`) was built to replace a raw list of unreviewed handles with an evidence-backed, reviewed shortlist. In its current shape it does the opposite for the common case (a fresh niche), because the worker does plan→search→scrape→review in ONE synchronous pass:

- **Race (no evidence at review time).** `guided-discovery.ts` enqueues `channel-scrape` (`scrapeQueue.add`, ~line 263) and then immediately runs `blogger_discovery_reviewer` in the SAME pass (~line 317). Newly-created channels are still `status='new'` with no posts/title → `hasData=false` (~line 327) → every new candidate hits the "awaiting scrape — no public evidence yet" `continue` (~line 331). Result for a fresh niche: `reviewed=0`, `recommended=0`, every new candidate left `needs_scrape`, yet the run is marked `status='done'`. Only pre-existing (`alreadyKnown`) channels ever get reviewed.

- **No recovery.** Nothing re-runs the reviewer after a scrape completes. `channel-scrape.ts` on success enqueues ONLY `contact-extract`; it has no knowledge of `DiscoveryRunCandidate`. The `scrape_refresh` candidate action (`discovery-guided.ts` ~line 330) re-enqueues a scrape and sets `pending_enrichment` but never re-reviews — so `score`/`recommendation`/`review` stay null forever. The "Обновить scrape" button is a dead end.

- **No bridge into work.** Even when a candidate IS reviewed and the operator saves/shortlists it, there is no action that puts the blogger into the downstream pipeline. The shortlist is a terminal artifact; the operator cannot launch a chosen blogger into agency-sourcing outreach from the workbench.

Net effect: "Разобрано" = 0 for fresh niches, "Сохранить" persists an unreviewed candidate with no evidence, and there is no path from shortlist → blogger actually in work. The feature ships the exact anti-result it was meant to remove.

## What Changes

- **Event-driven review loop.** Split the guided run. Phase 1 (the existing worker, trimmed) does plan→search→normalize→create/reuse `Channel`→enqueue scrape and sets the run to a new non-terminal state `enriching` (NOT `done`). `alreadyKnown` candidates that already carry evidence are still reviewed inline in phase 1. A new bounded review step (`guided-discovery-review`) scores a specific candidate once its evidence is available. The run transitions to `done` only when the review loop is closed (every candidate reviewed / failed / budget-exhausted), or via a bounded sweep fallback so a never-arriving scrape cannot wedge the run forever.

- **`channel-scrape` → guided review hook.** On scrape success AND failure, `channel-scrape.ts` enqueues a `guided-discovery-review` job for each non-terminal `DiscoveryRunCandidate` linked to that channel. Existing `contact-extract` chaining is unchanged. Scrape failure unblocks the candidate (reviewer records "insufficient evidence — scrape failed") instead of leaving it pending forever.

- **`scrape_refresh` actually re-scores.** The candidate action re-enqueues the scrape as today; the scrape→review hook closes the loop, so the button now yields a recommendation.

- **Honest run status + summary.** New non-terminal `enriching` status; summary exposes `pendingReview` (candidates awaiting evidence/review). The web page shows the status pill and "ожидают разбора: N", reusing the existing live poll (now also polling while `enriching`).

- **Launch-into-work bridge ("запуск в работу").** A new candidate action `launch` that reuses the EXISTING downstream path the codebase already uses to put a channel into a campaign and prepare agency-sourcing outreach (`campaignsService.addContacts(campaignId, contactIds)` → conversation upsert → `outreach_first_message` agent-run → **pending** opener suggestion for operator approval). The action selects only business/ad contacts (`ad_manager`/`owner`) of the candidate's channel, requires `channel_discovery` + (for the outreach campaign) `agency_sourcing`, requires admin/operator role, defaults the target campaign to the run's campaign, and — honoring `agency_sourcing`'s default human-approval gate — prepares the opener as a `pending` suggestion; it does NOT auto-send. **Critically, because `addContacts` honors the campaign's `defaultMode` (which can be `semi_auto`/`auto`, under which a first-touch opener auto-sends with no goal-fit gate — verified in `auto-approve.ts`), launch invokes `addContacts(..., { prepareOnly: true })`, which forces the conversation into `manual` mode so the opener cannot be auto-sent regardless of campaign settings.** Launch provenance is stored in a dedicated `launchedCampaignId` column (not `review`) so re-review cannot clobber it.

## Non-Goals

- Passing planner `negativeTerms`/`signal` into search (nice-to-have; explicitly out — would touch `packages/platforms`, which has unrelated uncommitted WIP).
- Multi-dimensional AJTBD sub-scores, operator-feedback learning loop, dedup-against-pipeline badges.
- Any change to `packages/platforms/src/index.ts` or `openspec/specs/runtime-feature-flags/spec.md` (unrelated pre-existing WIP — must not be touched).
- Auto-sending outreach on launch (forbidden by the human-approval gate; launch only prepares pending work).
- Run cancellation/abort. The feature has no cancel control today and the bounded enrichment deadline already prevents a wedged `enriching` run, so no `cancelled` state is added here; a future abort control must introduce one.

## Capabilities

### Modified Capabilities
- `ajtbd-blogger-discovery`: asynchronous evidence-then-review loop, `enriching` non-terminal status, `pendingReview` summary count, `scrape_refresh` re-scores, and the `launch` candidate action that bridges a shortlisted blogger into the downstream outreach pipeline under the human-approval gate.
- `channel-discovery`: `channel-scrape` success/failure additionally triggers a guided-discovery review for non-terminal candidates linked to the scraped channel, without changing single/batch discovery or `contact-extract` behavior.

## Impact

- **DB**: Prisma migration `9a_guided_discovery_enriching` (additive, mirrors `8_guided_discovery_runs`): new `enriching` value on `discovery_run_status` enum; `@@index([channelId])` on `discovery_run_candidate`; new nullable `review_claimed_at` (DateTime, atomic review claim) and `launched_campaign_id` (String, launch provenance) columns. No destructive changes.
- **Shared**: `GuidedRunStatusEnumZ` gains `enriching`; `GuidedRunSummaryZ` gains `pendingReview`; `CandidateActionZ` gains `launch` (with `campaignId` kept optional); `CandidateDecisionZ` gains `launched`; new `GuidedDiscoveryReviewJobZ` + `QueueNames.guidedDiscoveryReview`.
- **Workers**: `guided-discovery.ts` (phase-1 split + inline review of `alreadyKnown`; phase-1 scrapes enqueued `attempts:1`), new `guided-discovery-review.ts` (atomic claim + per-candidate review + run-completion check + sweep), `channel-scrape.ts` (success hook inline + failure hook bound to the BullMQ final-`failed` event). The new `guided-discovery-review` queue is registered in `apps/api/src/queues.ts` (the shared queue factory — there is no `apps/workers/src/queues.ts`) and its worker is started in `apps/workers/src/index.ts`.
- **API**: `discovery-guided.ts` `candidateAction` handles `launch` (resolving `campaignId ?? run.campaignId`) and re-arms + re-enqueues review on `scrape_refresh`; new `launch` reuses `campaignsService.addContacts(..., { prepareOnly: true })`. `campaigns.ts` `addContacts` gains the optional `prepareOnly` flag (forces `manual` mode). `routes/discovery.ts` audits the `launch` action.
- **Web**: `DiscoveryGuidedRunPage.vue` + `helpers.ts` + `types.ts` reflect `enriching` status, `pendingReview` count, and a "Запустить в работу" button on saved/shortlisted candidates.
- **Agents/seed**: no new agent (reuses `blogger_discovery_reviewer`); seed unchanged. If the reviewer prompt is adjusted to handle "scrape failed / insufficient evidence" explicitly, update the seed + its unit test.
- **Docs**: `AGENTS.md` (review-loop pipeline + launch bridge), `CHANGELOG.md` (operator-visible: honest status, working scrape_refresh, launch-into-work).
- **Compatibility**: existing `done`/`failed` runs unaffected (new status is additive). `launch` is gated and human-approval-bound; no breaking API changes.
