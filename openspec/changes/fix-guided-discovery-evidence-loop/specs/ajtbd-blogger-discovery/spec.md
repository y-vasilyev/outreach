## MODIFIED Requirements

### Requirement: Guided discovery run

The system SHALL provide an asynchronous guided blogger discovery run that accepts either a `campaignId` whose campaign goal/AJTBD is loaded from the database or a standalone operator brief with AJTBD-like fields. The run SHALL be gated by `channel_discovery`, require an admin/operator role, persist its input, status, timestamps, trace events, candidate results, and final summary, and return quickly with `{ id }` so the UI can poll progress.

The run status SHALL be one of `pending`, `running`, `enriching`, `done`, `failed`. `enriching` is a NON-terminal state meaning phase-1 work (plan → search → normalize → enqueue scrape) is complete but one or more candidates are still awaiting public evidence and review. A run SHALL NOT be marked `done` while any candidate is still pending review. The run summary SHALL expose a `pendingReview` count of candidates awaiting evidence/review so the UI never shows a terminal/green state while candidates are unreviewed.

#### Scenario: Create a campaign-guided run
- **WHEN** an admin/operator starts guided discovery with a valid `campaignId`
- **THEN** the API persists a guided discovery run with the campaign's goal/AJTBD snapshot, enqueues the guided-discovery worker, and returns `{ id }` without making Yandex or LLM calls inline

#### Scenario: Create a manual brief run
- **WHEN** an admin/operator starts guided discovery with a manual niche/AJTBD brief and no `campaignId`
- **THEN** the API persists the supplied brief as the run input, enqueues the guided-discovery worker, and returns `{ id }`

#### Scenario: Feature flag blocks guided discovery
- **WHEN** `channel_discovery` is off and a request hits guided discovery endpoints
- **THEN** the API responds with the same feature-disabled 404 behavior as the existing discovery routes and no run or worker job is created

#### Scenario: Fresh-niche run enters enriching rather than done
- **WHEN** a run's planned searches surface only newly-created channels (no pre-existing scraped channels)
- **THEN** phase 1 enqueues scrape for each candidate, leaves those candidates non-terminal, sets the run status to `enriching` with `summary.pendingReview > 0`, and does NOT mark the run `done`

### Requirement: Candidate enrichment with public evidence

The guided discovery worker SHALL normalize search results to supported platform channels, deduplicate candidates across all planned queries, create or reuse `Channel` rows, and gather public evidence for each candidate from available channel metadata, recent public posts, and existing `BloggerProfile` data. If a newly discovered candidate has not been scraped yet, the worker SHALL enqueue scrape and mark that candidate as `needs_scrape` or `pending_enrichment` rather than pretending evidence exists.

Candidate review SHALL be event-driven, not a single synchronous pass: candidates that already carry public evidence at phase-1 time (e.g. pre-existing scraped channels) SHALL be reviewed inline; candidates whose channel is still being scraped SHALL be reviewed AFTER their scrape completes, triggered by the channel-scrape → guided-review hook, rather than being skipped permanently because evidence was not yet present.

#### Scenario: Existing channel candidate is reused
- **WHEN** a planned query finds a platform/handle that already exists in `channel`
- **THEN** the candidate links to the existing channel, is not duplicated, and its existing scrape/profile data is used for scoring when available

#### Scenario: Known channel with evidence is reviewed inline
- **WHEN** a candidate links to an already-scraped channel with public posts/metadata at phase-1 time
- **THEN** the worker reviews it inline during phase 1 (within the review budget) and persists its score/recommendation without waiting for an event

#### Scenario: New channel candidate is reviewed after its scrape completes
- **WHEN** a planned query finds a new platform/handle, the worker creates `channel(status='new')` and enqueues `channel-scrape`, and the scrape later completes
- **THEN** the candidate is reviewed by the guided-review step triggered from the scrape completion, its `score`/`recommendation`/evidence are persisted, and the candidate stops being counted in `pendingReview`

#### Scenario: Evidence only uses public data
- **WHEN** candidate evidence is assembled
- **THEN** it includes only public channel/profile fields, public recent posts, public URLs, and existing public-derived profile data; it SHALL NOT include personal contacts without business context or hidden/private data

### Requirement: Discovery workbench UI

The Discovery UI SHALL render guided discovery as an operator workbench: input panel for campaign/manual brief, live trace log, planned queries, candidate shortlist, evidence post previews, fit recommendations, and action buttons. Candidate rows/cards SHALL be clickable to inspect channel/profile detail where available and to view matching posts without leaving the run context. The UI SHALL surface the `enriching` status and the `pendingReview` count, and SHALL keep polling while a run is `running` or `enriching`.

#### Scenario: Run detail shows live trace and candidates
- **WHEN** an operator opens a running guided discovery run
- **THEN** the page polls run detail and renders current status, trace events, planned queries, candidate counts, and any candidates already scored

#### Scenario: UI shows awaiting-review while enriching
- **WHEN** a run is in the `enriching` status with `summary.pendingReview = N`
- **THEN** the status pill reflects `enriching` (not a green/done tone), the UI shows "ожидают разбора: N", and the page keeps polling until the run reaches `done` or `failed`

#### Scenario: Operator inspects matching posts
- **WHEN** an operator expands a recommended blogger candidate
- **THEN** the UI shows the matching public post snippets, dates/links when available, and the reviewer explanation for each evidence item

#### Scenario: Operator can act on a candidate
- **WHEN** an operator marks a candidate as saved/shortlisted/rejected or requests scrape refresh
- **THEN** the action is persisted on the guided run candidate and reflected in the run detail without mutating unrelated candidates

#### Scenario: Scrape refresh re-scores the candidate
- **WHEN** an operator triggers `scrape_refresh` on a candidate — including a candidate that was ALREADY reviewed (with a recommendation or as insufficient-evidence)
- **THEN** the candidate is re-armed for review (so a non-null prior `review` does not cause the hook to skip it), the worker re-scrapes the channel, the scrape→guided-review hook re-runs the reviewer, the stale `score`/`recommendation`/evidence are replaced with the new result (the action is no longer a dead end), and if the run had already reached `done` it reopens to `enriching` until the refresh review closes

## ADDED Requirements

### Requirement: Run completion and bounded enrichment

A guided discovery run SHALL transition from `enriching` to `done` only when every candidate has reached a terminal review outcome — reviewed with a recommendation, reviewed as insufficient-evidence, or excluded by the per-run review budget. Completion SHALL be idempotent under concurrent review jobs (exactly one transition to `done`). A never-arriving or failed scrape SHALL NOT keep a run in `enriching` indefinitely: a bounded deadline sweep SHALL force still-open candidates to a terminal insufficient-evidence outcome and complete the run.

Review of a candidate SHALL be at-most-once per evidence generation under duplicate or concurrent review jobs: a deterministic per-candidate review job identity and an atomic candidate claim taken BEFORE any reviewer LLM call SHALL ensure that duplicate jobs for the same candidate do not each invoke the reviewer (no reviewer cost regression). A deliberate `scrape_refresh` SHALL constitute a new evidence generation that is eligible to be reviewed again.

#### Scenario: Duplicate review jobs do not double-spend the reviewer
- **WHEN** two review jobs are enqueued for the same candidate and the same evidence generation (e.g. a scrape hook racing a sweep)
- **THEN** exactly one job claims the candidate and invokes the reviewer; the other observes the claim and exits without calling the reviewer or spending tokens

#### Scenario: Run completes when the last candidate is reviewed
- **WHEN** the final pending candidate of an `enriching` run is reviewed (success or insufficient-evidence)
- **THEN** the run transitions to `done` exactly once with `completedAt` set and `summary.pendingReview = 0`

#### Scenario: Failed scrape unblocks the candidate
- **WHEN** a candidate's `channel-scrape` fails
- **THEN** the scrape→guided-review hook records the candidate with an insufficient-evidence reason (no fabricated review), the candidate stops counting toward `pendingReview`, and the run can still complete

#### Scenario: Bounded sweep completes a wedged run
- **WHEN** one or more candidates never receive a scrape result within the enrichment deadline
- **THEN** a sweep marks each still-open candidate as insufficient-evidence (scrape did not complete in time) and transitions the run to `done`

#### Scenario: Review budget is respected across inline and event reviews
- **WHEN** the number of reviewable candidates exceeds the run's `maxReviewed` budget across both phase-1 inline reviews and scrape-triggered reviews
- **THEN** the worker reviews only up to the budget, records skipped candidates in the trace/summary, and does not exceed the budget by issuing extra reviewer LLM calls

### Requirement: Launch a discovered blogger into the outreach pipeline

The guided discovery workbench SHALL provide an operator `launch` action that puts a saved/shortlisted candidate's blogger into the existing downstream outreach pipeline by reusing the campaign's contact-intake path (`addContacts` → conversation upsert → `outreach_first_message`), NOT a parallel sending path. The action SHALL be gated by `channel_discovery` and require an admin/operator role; when the target campaign's type is `agency_sourcing`, the `agency_sourcing` flag SHALL be required (else a 422 `AGENCY_SOURCING_DISABLED`). The target campaign id MAY be supplied in the request and SHALL default to the run's campaign when omitted; if neither is available the API SHALL respond with a clear error. Only explicitly-published business/ad contacts (role `ad_manager` or `owner`) of the candidate's channel SHALL be eligible; `generic`, `bot`, and `unknown` role contacts SHALL NOT be used (a `generic` business handle may be added manually by the operator from the channel view, but launch SHALL NOT auto-include it).

The launch action SHALL NOT auto-send any message under any campaign mode. Because the contact-intake path honors the campaign's default conversation mode — which may be `semi_auto` or `auto`, under which a first-touch opener can be auto-sent without a goal-fit gate — the launch action SHALL force the prepared conversation into a non-sending (`manual`) mode independent of the campaign's default mode (e.g. via a `prepareOnly` intake option), so the opener lands as a `pending` suggestion that the auto-approve path refuses. The action SHALL prepare outreach as a `pending` opener suggestion for operator approval, honoring the `agency_sourcing` default human-approval gate. Launch provenance (the target campaign id) SHALL be stored in a dedicated field separate from the reviewer output so a subsequent re-review cannot clobber it.

#### Scenario: Launch prepares pending outreach in a non-sending mode, does not auto-send
- **WHEN** an operator launches a shortlisted candidate into an `agency_sourcing` campaign (whose default mode may be `semi_auto`/`auto`) and a business/ad contact exists
- **THEN** the candidate's business/ad contacts are tagged into the campaign, a conversation is upserted in a non-sending (`manual`) mode regardless of the campaign's default mode, an `outreach_first_message` job is enqueued that posts a `pending` opener suggestion, the candidate decision is set to `launched` with the launch campaign recorded in a dedicated provenance field, and NO message is auto-sent

#### Scenario: Launch blocked when agency flag is off
- **WHEN** an operator launches into a campaign of type `agency_sourcing` while the `agency_sourcing` flag is off
- **THEN** the API responds 422 `AGENCY_SOURCING_DISABLED` and nothing is enqueued

#### Scenario: Launch requires a business/ad contact
- **WHEN** the candidate's channel has no contact with role `ad_manager` or `owner`
- **THEN** the API responds with a clear error indicating no business/ad contact is available (the operator may scrape/extract first), and no conversation or outreach job is created

#### Scenario: Launch requires a linked channel
- **WHEN** an operator launches a candidate that has no linked `channelId`
- **THEN** the API responds with a clear error and no outreach is prepared

#### Scenario: Launch defaults the campaign to the run's campaign
- **WHEN** an operator launches a candidate without supplying a `campaignId` and the run was created with a `campaignId`
- **THEN** the run's campaign is used as the launch target; if the request omits `campaignId` AND the run has none, the API responds with a clear error and no outreach is prepared
