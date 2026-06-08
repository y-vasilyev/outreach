## 1. DB migration + schema (packages/db)

- [ ] 1.1 Add `extractionStatus String @default("pending")`, `extractionError String?`, `extractedAt DateTime?` to `Message` in `schema.prisma` + index `@@index([conversationId, extractionStatus])` for status-filtered reads.
- [ ] 1.2 Add `ExtractionHint` model: `{ id, scope (string), channelId String?, conversationId String?, targetField String?, guidance String, exampleInput String?, exampleOutput String?, active Boolean @default(true), createdById String?, createdAt }` with indexes on `(scope, active)`, `(channelId)`, `(conversationId)`.
- [ ] 1.3 Migration `9c_operator_reanalyze_and_markup` (sorts after `9b_*`): the three `message` columns + index + `extraction_hint` table; `pnpm db:migrate` to generate the client.

## 2. Shared schemas (packages/shared)

- [ ] 2.1 Add zod: `ReanalyzeRequestZ` (optional supersede default true), `OperatorDataPointWriteZ` (FIELD-AWARE: discriminated/refined per field — numeric for reach/avgViews/rate.*/audience.subscribers.*, PlacementOfferZ for placement.offer, record for audience.geo|age|gender; reject other fields), `ExtractionHintZ` + `ExtractionHintScopeZ` (refine: channel scope requires channelId, conversation scope requires conversationId), a `message.extraction_status.changed` realtime event type, and extend `ProfileExtractJobZ` with `supersede?: boolean`.
- [ ] 2.2 Add an `operator_hints: string[]` field to the extractor input schemas (`rateCardExtractorInputSchema`, `audienceStatsExtractorInputSchema`), default `[]`.
- [ ] 2.3 Unit-test the schemas (supersede default, hint scope enum).

## 3. Worker: status + supersede + hints (apps/workers/src/queues/profile-extract.ts)

- [ ] 3.1 Stamp `Message.extractionStatus` via a `stampStatus()` helper: `no_signal` (pre-gate), `empty` (zero facts), `ok` (wrote), `extractedAt` set. Stamp `failed` (+error) ONLY at terminal points — the sync `handleOnInbound` catch and the worker `failed` event hook after retries exhausted — NOT on each throw. Emit `message.extraction_status.changed` on terminal stamps.
- [ ] 3.2 Implement supersede: when `job.supersede`, AFTER both extractors succeed and INSIDE the write transaction (before the create loop) delete prior `profile_data_point` rows for `(profileId, sourceMessageId)`, `placement_attribute` rows for `sourceMessageId`, and the prior `raw_payload` media_asset for the message. Never delete operator points (`sourceMessageId=null`). Set `messageId=sourceMessageId` on the raw-payload row so prior ones are findable/deletable.
- [ ] 3.3 Load applicable hints (`global` ∪ channel ∪ conversation, active, capped 10×500 chars) and pass as `operator_hints` in `extractorInput`.
- [ ] 3.4 Tests: status stamped for ok/empty/no_signal; `failed` only on terminal (sync catch / final retry), `pending` between retries; supersede replaces all row kinds incl. raw_payload and does NOT touch an operator point; hints passed to the extractor input.

## 4. Agents consume hints (packages/agents)

- [ ] 4.1 `RateCardExtractor` + `AudienceStatsExtractor`: accept `operator_hints`, render into the prompt under a fenced «ПОДСКАЗКИ ОПЕРАТОРА (advisory)» block (only when non-empty), with an explicit instruction that hints are interpretation rules and the extractor must still emit only facts present in the source text; keep tolerant validation. Ensure `redact()` covers the input before logging.
- [ ] 4.2 Test: a hint string appears in the rendered prompt / influences a mocked extraction path.

## 5. API routes (apps/api)

- [ ] 5.1 `POST /conversations/:id/messages/:mid/reanalyze` (operator/admin): validate the message is an inbound of the conversation; enqueue profileExtract `{ conversationId, sourceMessageId, supersede: true }` (plain enqueue or a `-`-delimited jobId — never an invalid colon shape; see BullMQ 3-part-colon rule); set the message to `pending` and return so the UI shows immediate progress.
- [ ] 5.2 `POST /blogger-profiles/:id/data-points` + `DELETE /blogger-profiles/:id/data-points/:dpid` (operator/admin): write operator-origin point / delete a point, then re-roll the profile (reuse the roll-up service).
- [ ] 5.3 Extraction-hint CRUD: `GET/POST /extraction-hints`, `PATCH/DELETE /extraction-hints/:id` (operator/admin).
- [ ] 5.4 Include `extractionStatus`/`extractionError`/`extractedAt` in the message read; include data-point `extractedBy` origin in the profile read (already on the row — ensure surfaced).
- [ ] 5.5 Route tests: reanalyze enqueues with supersede; operator data-point write re-rolls and wins; hint CRUD scoping.

## 6. Web (apps/web)

- [ ] 6.1 Inbox: per-message extraction-status badge + «Переанализировать» button (calls reanalyze; shows pending→result via the `message.extraction_status.changed` realtime event).
- [ ] 6.2 Profile data-points table: inline correct (write operator point) + delete control.
- [ ] 6.3 Hint form: create a hint from a failed/empty message or the profile (scope channel/conversation/global).
- [ ] 6.4 Web tests for the status badge + reanalyze action.

## 7. Verification

- [ ] 7.1 `pnpm db:migrate` applies (last in lexical order); `pnpm typecheck && pnpm lint && pnpm test` green.
- [ ] 7.2 Update `CHANGELOG.md` (operator-visible: see/redo failed analysis, fix values, teach agents).
- [ ] 7.3 `openspec validate operator-reanalyze-and-markup --strict` passes.
