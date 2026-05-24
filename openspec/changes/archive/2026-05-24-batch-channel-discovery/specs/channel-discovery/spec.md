## ADDED Requirements

### Requirement: Batch discovery over multiple niches

The system SHALL accept a batch request of up to 50 niches via `POST /discovery/batch` and process them asynchronously through a worker that executes the same per-niche pipeline as the single-niche `discoveryService.search` (search → normalise → persist new `channel(status='new')` → enqueue `channel-scrape`). The pipeline body is duplicated in the worker rather than factored into a shared helper — see the change's design.md Decision 1.

Per-niche failures SHALL NOT abort the batch — the batch records the error for that niche and moves on. The terminal status is `done` (even if all niches errored) or `failed` (only when the worker itself crashed before processing any niche).

#### Scenario: Batch enqueue returns an id quickly

- **WHEN** an admin or operator submits `POST /discovery/batch` with `{ queries: ['ниша 1', 'ниша 2', ..., 'ниша 50'] }`
- **THEN** the API responds within < 1 second with `{ id }`, persists a `DiscoveryBatch` row with `status='pending'`, and enqueues a worker job; no Yandex API calls happen in the HTTP request

#### Scenario: Worker processes niches sequentially

- **WHEN** the `discovery-batch` worker picks up a job with N niches
- **THEN** it iterates the niches one-by-one (concurrency 1, ~1s rate-limit pause between iterations), runs the duplicated per-niche pipeline (search → normalise → create/skip channel → enqueue scrape) for each, and accumulates results in `DiscoveryBatch.summary` — per-niche `{ candidates, created, alreadyKnown, error? }` plus totals (recomputed deterministically from queries after every iteration)

#### Scenario: One bad niche doesn't break the batch

- **WHEN** one niche causes the search to throw (Yandex 5xx, parse error, etc.)
- **THEN** the batch's summary marks that niche with `error: '<message>'`, all subsequent niches still process, and the batch terminates with `status='done'` and `summary.totals.errored >= 1`

#### Scenario: Status endpoint reflects the live progress

- **WHEN** an admin or operator polls `GET /discovery/batch/:id` while the worker is mid-flight
- **THEN** the response includes the current `status` (`pending`/`running`/`done`/`failed`), the partial `summary` (niches processed so far + totals so far), and `createdAt` / `completedAt?`

#### Scenario: Behind the channel_discovery feature flag

- **WHEN** the `channel_discovery` runtime flag is OFF
- **THEN** `POST /discovery/batch`, `GET /discovery/batch/:id`, and `GET /discovery/batch` all return 404 (`requireFeature(...)` preHandler), and no worker job is enqueued

#### Scenario: Recent batches are listable

- **WHEN** an admin or operator calls `GET /discovery/batch`
- **THEN** the response is an array of the latest 20 `DiscoveryBatch` rows ordered by `createdAt` desc, each with `id`, `status`, `createdAt`, `completedAt?`, `platform`, `limitPerQuery`, and `totals` (no `summary.queries[]` — that's only on the `:id` endpoint, so listing many batches stays small)

#### Scenario: Resumable after a worker crash

- **WHEN** the worker is killed mid-batch (after some niches finished) and BullMQ retries the same job at least 2 minutes later (so the stale-lock gate on `updatedAt` opens)
- **THEN** the second worker invocation atomically claims the row via `updateMany({ where: { id, OR: [{status:'pending'}, {status:'running', updatedAt:{lt: NOW - 2min}}] }, data: { status:'running' } })`, iterates the niches again, skips any niche already marked `done: true` in summary, processes the remaining niches, recomputes totals deterministically from the per-niche records, and finalises the batch with `status='done'` exactly once

#### Scenario: Concurrent claim is rejected

- **WHEN** two worker invocations race to claim the same `DiscoveryBatch` while it is actively being processed (so its `updatedAt` is fresher than the stale-lock window)
- **THEN** only one `updateMany` returns `count = 1`; the loser sees `count = 0`, logs the lost race, and exits without touching the summary

#### Scenario: Setup error after the claim marks the batch failed

- **WHEN** the worker successfully claims a row but a pre-loop step (decrypt of the Yandex integration, RPC client construction, etc.) throws
- **THEN** the row is updated with `status='failed'`, `completedAt` set, and `summary.fatalError` populated with the message — it MUST NOT remain stuck in `running`
