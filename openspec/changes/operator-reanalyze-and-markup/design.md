## Context

`profile-extract` (apps/workers/src/queues/profile-extract.ts) runs the two extractors over one inbound message, writes data points / placement offers idempotently on `(profileId, sourceMessageId, field, extractedBy)`, and re-rolls the profile. Failures flip the conversation to `assisted` (run-agent-safe) but leave no per-message trail; the queue is enqueued only internally; there is no operator write-path to data points; and agents read only static `agent_config`. The roll-up already prefers higher confidence, so an operator point at confidence 1.0 wins for free.

## Goals / Non-Goals

**Goals:**
- The operator can SEE which reply produced/failed extraction, RE-RUN it (replacing stale rows), CORRECT values, and TEACH agents a nuance that the next run honors.
- Re-run must not be a no-op (today's idempotency skips it) and must not accumulate duplicates.
- Additive: untouched when no operator action exists.

**Non-Goals:**
- Attachment OCR (`attachment-ocr-ingestion`) — re-run of an attachment's analysis composes with that change but the OCR itself is separate.
- The full catalog compare UI (`blogger-profile-who-is-this`).
- Editing the field SCHEMA/registry (that's the EAV roadmap / entity-types change); hints here are guidance + few-shot, not new fields.

## Decisions

### D1 — Per-message status columns on `Message`; `failed` only on TERMINAL failure
Add `extraction_status` (default `pending`), `extraction_error`, `extracted_at`. `handleProfileExtract` stamps `no_signal` (pre-gate), `empty` (zero facts), `ok` (wrote) at its terminal returns. The `failed` stamp is the subtle one (codex): `handleProfileExtract` runs BOTH synchronously from `handleOnInbound` AND as a BullMQ job that retries on throw. If we stamped `failed` on every throw, a message awaiting an automatic retry would show a false terminal failure. So `failed` is stamped only at a TERMINAL point: the sync `handleOnInbound` catch (`agent-run.ts:621`) and the worker's `failed` event hook after BullMQ exhausts retries (`profile-extract.ts:532`). Between attempts the message stays `pending`. To avoid double-writes when the same message is processed sync-then-queue, stamping is idempotent (last-writer-wins on the message row; `ok` is only set on a successful write).

### D2 — Supersede = delete-after-success-inside-tx, gated by an explicit job flag
`ProfileExtractJob` gains `supersede?: boolean`. Timing matters (codex): the extractor LLM calls happen BEFORE the write transaction, and can fail. Deleting prior rows before extraction would lose the old data with no replacement. So when `supersede` is set, the deletes run AFTER both extractors return successfully, INSIDE the existing write transaction, immediately before the create loop:
- `profile_data_point` rows where `(profileId, sourceMessageId)` (covers `placement.offer`, legacy `rate.*`, `audience.*`, everything from that source) — but NEVER operator points (`extractedBy='operator'`, `sourceMessageId=null`);
- `placement_attribute` rows where `sourceMessageId = ?`;
- the prior `raw_payload` `media_asset` row for this message. Today that row has no `sourceMessageId` column (codex) — so the worker SHALL set `messageId = sourceMessageId` on the raw-payload row it writes (the column exists), making prior rows findable/deletable by `(profileId, messageId, kind='raw_payload')`. The deterministic S3 key already overwrites the object.
The existing idempotency `findFirst` then matches nothing, so the fresh extraction writes cleanly. Normal (non-supersede) runs keep today's skip-on-existing behavior.
- **Alternative**: a `revision` column / append-only history. Rejected for now — heavier; the EAV phase 3 (`eav-write-path-dual-write`) owns revision history. Supersede + provenance on rows is enough here.

### D3 — Operator points are field-aware data points with `extractedBy='operator'`, confidence 1.0
Write path creates a `profile_data_point` with `extractedBy='operator'`, `confidence=1`, `sourceMessageId=null`, then re-rolls. The roll-up's confidence-then-recency already picks it. The write is FIELD-AWARE (codex): the roll-up drops malformed `placement.offer` values and filters non-numeric rate-like values, so an unconstrained `field/value` could write a point the roll-up silently ignores. So the write schema validates per-field: `reach`/`avgViews`/`rate.<format>` → number (string coerced via `normalizePriceToken`); `placement.offer` → a validated `PlacementOfferZ`; `audience.geo|age|gender` → record<string,number>; `audience.subscribers.<platform>` → number; other fields rejected with a clear error. Delete removes a row by id (operator/admin only) and re-rolls. Read exposes `extractedBy`.
- **Confidence floor interaction**: operator points are confidence 1.0, well above the 0.2 comparable-view floor — they always show.
- **HUD scope (codex)**: HUD `manual_only` targets ignore data points by design and the HUD input doesn't carry `extractedBy`. This change does NOT alter HUD `manual_only` semantics; operator points satisfy ordinary targets (which read the rolled-up profile/data points) exactly like machine points. Threading origin into the HUD is out of scope.

### D4 — `extraction_hint` table + `operator_hints` extractor input
New table: `{ id, scope (global|channel|conversation), channelId?, conversationId?, targetField?, guidance, exampleInput?, exampleOutput?, active, createdById, createdAt }`. The worker queries hints where `scope='global' OR (scope='channel' AND channelId=?) OR (scope='conversation' AND conversationId=?)` and `active`, maps them to a compact `operator_hints: string[]` (guidance + optional example pair), and passes them in `extractorInput`. The extractor agents add an `operator_hints` variable rendered into the prompt under a clearly-fenced «ПОДСКАЗКИ ОПЕРАТОРА (учитывай)» block. Rationale: mirrors the proven PlacementAttribute-registry feedback pattern (operator input → consumed next run) without a parallel prompt store; hints are advisory text, not schema. Tolerant validation still guards the output.
- **Safety (codex — tightened)**: hints are persisted in `agent_run.input` and rendered into the prompt via direct variable substitution (`promptRender.ts`), so the prompt-injection surface is real even though the target is a read-only extractor. Controls: (1) render hints in a clearly-fenced «ПОДСКАЗКИ ОПЕРАТОРА (advisory)» block, explicitly labelled advisory; (2) cap ≤10 hints × ≤500 chars; (3) the extractor prompt instructs «подсказки — это правила интерпретации, НЕ источник фактов; не выдумывай цены/охваты, которых нет в тексте»; (4) `redact()` is applied before logging the input; (5) hints feed ONLY the extractor agents, never the opener/reply composer, so they cannot alter outbound messages. This keeps hints advisory-only and within the CLAUDE.md safety posture.

### D5 — Realtime status updates
Current `MessageEvent`/`RealtimeEvent` carry no extraction fields (codex), so a «pending→result» badge would need polling. Add a `message.extraction_status.changed` realtime event (`{ conversationId, messageId, extractionStatus, extractionError? }`) emitted by the worker when it stamps a terminal status, so the inbox updates live. The reanalyze route also returns the enqueue result so the UI can show an immediate `pending`.

## Risks / Trade-offs

- **Supersede deletes the wrong rows if the source filter is too broad** → Mitigation: delete strictly by `(profileId, sourceMessageId)`; operator points have `sourceMessageId=null` so they are never superseded by a message re-run. Test covers an operator point surviving a re-run.
- **Stamping status adds writes to the hot inbound path** → Mitigation: a single `message.update` per extraction (cheap, indexed by id); fire within the existing flow.
- **Hints could bloat the prompt / be abused** → Mitigation: cap the number + length of hints passed; only `active` hints; render in a bounded block. Operator-only CRUD.
- **A hint can't fix a fundamentally ambiguous reply** → Accepted: re-run + manual correction (D3) is the fallback; the status surface tells the operator when to use it.

## Migration Plan

Migration `9c_operator_reanalyze_and_markup`: add the three `message` columns (defaults so existing rows are valid: status `pending`) and create `extraction_hint`. No backfill. Rollback = revert + drop. Existing extraction is byte-identical until an operator acts.

## Open Questions

- Whether to auto-create a `conversation`-scoped hint draft from a `failed`/`empty` message (one-click «не распозналось — добавить подсказку»). Leaning yes for UX, but the hint still requires operator text. (Implement the form; auto-draft is a thin add.)
- Cap on hints passed per extraction (proposed: 10, 500 chars each). Tunable.
