## Purpose

On-open conversation sync that backfills missed Telegram messages when the operator clicks a chat, so the inbox never shows a thread older than what TG has — even after a worker outage. Bounded fetch (≤ 50 msgs), 30s cache, FloodWait-friendly, time-budgeted to keep `GET /conversations/:id` responsive.

## Requirements

### Requirement: On-open conversation sync service

The system SHALL provide a `ConversationSync.syncOne(conversationId)` service that, when invoked, fetches the most recent messages of the corresponding Telegram peer (bounded to ≤ 50 messages descending from the current head), persists any messages newer than what is in the database (deduplicating on `Message.tgMsgId` per conversation), updates `Conversation.lastSyncedAt`, and enqueues `agent-run on_inbound` for the most recent newly persisted inbound message only.

#### Scenario: Sync persists a missed inbound and triggers the agent pipeline
- **WHEN** the operator opens a conversation that received one missed inbound message while workers were offline
- **THEN** the sync service persists the missed message with the same fields as the push path would, updates `Conversation.lastSyncedAt`, and enqueues exactly one `agent-run on_inbound` job for that message

#### Scenario: Sync deduplicates messages already persisted
- **WHEN** the sync service fetches a slice that overlaps with already-persisted messages
- **THEN** no duplicate `Message` rows are created (uniqueness on `(conversationId, tgMsgId)` is enforced) and no extra `agent-run` jobs are enqueued for the overlapping rows

#### Scenario: Long outage produces bounded suggestion regeneration
- **WHEN** the sync service persists multiple missed inbound messages from a long outage
- **THEN** only the most recent newly persisted inbound triggers `agent-run on_inbound`; older backfilled inbounds are persisted but do not each spawn their own suggestion-generation job

### Requirement: Triggering sync on conversation open

`GET /conversations/:id` SHALL invoke `ConversationSync.syncOne(:id)` before returning, with a hard time budget (default 1500ms). If sync completes within the budget, the response reflects the post-sync state. If sync exceeds the budget, the API SHALL respond with the current database state and let the sync continue in the background; the UI receives newly persisted messages via the existing `message.new` realtime event.

#### Scenario: Fast sync returns post-sync state
- **WHEN** an operator opens a conversation and sync completes within the time budget
- **THEN** the API response includes any newly persisted messages and the updated `lastSyncedAt`

#### Scenario: Slow sync degrades gracefully
- **WHEN** an operator opens a conversation and sync exceeds the time budget
- **THEN** the API responds with the current database state, the sync continues in the background, a structured log line records the budget overrun, and the UI receives any newly persisted messages via realtime once sync completes

#### Scenario: TG transport failure does not break the open flow
- **WHEN** the underlying TG client cannot fetch history for the peer (FloodWait, transport error, account paused)
- **THEN** the API still returns the current database state with an HTTP 200, the failure is logged with structured fields including the conversation id and error code, and the UI is not impacted beyond seeing stale data

### Requirement: Idempotent reuse of the on-inbound persistence path

Backfilled inbound messages SHALL be persisted via the same code path used by the existing `tg-listen` worker, including writing the realtime `message.new` event so the inbox UI reflects the new message regardless of whether sync was triggered by the API call or by the push listener.

#### Scenario: Backfilled message reaches the UI exactly once
- **WHEN** a missed inbound is persisted via the sync service
- **THEN** a `message.new` realtime event is published exactly once for that message, even if the push listener later sees the same message (uniqueness check prevents the second persist)

### Requirement: Caching and quota safety

The system SHALL cap per-conversation sync rate to at most one `messages.getHistory` call per 30 seconds; rapid repeat opens within the cap return the most recent cached result and skip the TG call. The system SHALL respect FloodWait by returning current DB state and incrementing a metric counter rather than retrying inline.

#### Scenario: Rapid repeat opens hit cache
- **WHEN** an operator opens the same conversation twice within 30 seconds
- **THEN** the second open serves from the cached recent state and does not trigger another `messages.getHistory` call

#### Scenario: FloodWait is observed and surfaced
- **WHEN** the TG client returns a FloodWait error on `messages.getHistory`
- **THEN** the sync service does not retry inline, returns control to the API handler with a structured log line, and increments a `tg.flood_wait` metric counter

### Requirement: Observability of sync coverage

The system SHALL emit a metric counter `tg.message.first_persist_via_sync` whenever a message is first persisted via `ConversationSync.syncOne` (rather than the push path), to surface unhealthy push-path coverage as an alertable signal.

#### Scenario: Metric increments on first-persist via sync
- **WHEN** a missed inbound is persisted by the sync service that was never seen by the push listener
- **THEN** the `tg.message.first_persist_via_sync` counter increments by 1
