## Context

`profile-extract` feeds only `sourceMessage.text` to the extractors. Inbound media is downloaded to S3 as a `MediaAsset` (`tg-listen`/`media-store`, behind `object_storage`), with a lazy byte path via the tg-client `downloadInboundMedia`. The LLM layer is text-only: `CompletionRequest` is `{systemPrompt, userPrompt, …}` and the OpenRouter provider sends `messages:[{role,content:string}]`. So a media-kit PDF / price screenshot contributes nothing, and the pre-gate skips a text-empty attachment reply as `no_signal`.

## Goals / Non-Goals

**Goals:**
- Recognized attachment text feeds the EXISTING extractors (no new extraction logic), so prices/reach in files land in the catalog.
- OCR is accounted (`agent_run`), cached per asset, idempotent, and double-gated (`attachment_ocr` + `object_storage`).
- Text-only and non-OCR flows are byte-identical; providers without image support never break.

**Non-Goals:**
- A bespoke document-layout parser — the vision model transcribes to text and the existing extractors structure it.
- Full attachment-preview UI (`blogger-profile-who-is-this`); this change only exposes `ocrStatus`.
- Yandex Cloud OCR — the chosen provider is OpenRouter multimodal; the design leaves room for a second provider later but does not build it.

## Decisions

### D1 — `CompletionRequest.images` + OpenRouter-ONLY multimodal content (provider-guarded)
Add `images?: Array<{ url: string }>` (a data-URL or http URL). When present, the OpenRouter path builds the user `content` as parts: `[{type:'text',text}, ...images.map(i=>({type:'image_url',image_url:{url}}))]`; when absent the body is byte-identical to today. **Guard (codex)**: `openai_compat` reuses `doOpenAICompatCall` from `openrouter.ts`, so the multimodal branch must be conditioned on the OpenRouter provider (e.g. an explicit `opts.multimodal === true` flag set only by the OpenRouter provider, or the branch lives in the OpenRouter provider, not the shared helper) — otherwise openai_compat would also send image parts. Yandex stays text-only. Tests assert OpenRouter renders parts while openai_compat/Yandex stay string-content. **v1 is IMAGES ONLY**: no `files`/PDF `type:'file'` shape this change.

### D2 — `media_ocr_extractor` agent (transcribe); image bytes NEVER persisted to agent_run
The OCR agent transcribes image→verbatim text (+ a one-word kind hint), NOT structuring — the existing extractors structure free text. It runs via `AgentRunner` (accounted, retried) through a new `invokeVisionText(ctx, {userPrompt, images, fallbackSystemPrompt})` helper that passes `images` to `ctx.llm.complete`. **Redaction contract (codex blocker)**: `AgentRunner.persistRun` writes the agent INPUT verbatim to `agent_run.input` and there is no redaction layer. So the OCR agent's persisted input MUST be METADATA ONLY — `{ assetId, mime, bytes, sha256 }`. The base64 data-URL is built inside `run()` and handed to `invokeVisionText`/`complete` as a runtime side channel; it is NEVER part of the object AgentRunner persists/logs. (Belt-and-suspenders: also truncate any `images[].url` in `persistRun` if present.) Default model = a vision-capable OpenRouter id (configurable in `agent_config`).

### D3 — OCR inside profile-extract: order, selection, atomic claim, byte fetch
Order (codex): resolve source message -> load OCR-able assets -> claim+run/reuse OCR -> build `combinedText = text + ocrTexts` -> ONLY THEN the empty/pre-gate check on `combinedText`. So OCR happens before the `no_signal`/empty short-circuits.
- **Selection**: assets with `s3Key != ''` and an image mime (`screenshot`/`image`/`media_kit`/`other`); EXCLUDE `raw_payload`. TG photos store `mime: null` (`media-store.ts:100`) — infer `image/jpeg` for image-kind assets; reject unknown/document mimes as `unsupported`.
- **Byte fetch (codex)**: `ObjectStore` has no download today — add `getObject(key): Promise<Uint8Array>` and prefer `s3Key` bytes; fall back to the tg-client `downloadInboundMedia` path (via `sourceTgMsgId`) only for metadata-only assets.
- **Atomic claim (codex)**: before the LLM call, `updateMany WHERE id=? AND ocr_status IN ('pending','failed') SET ocr_status='processing'`; only the worker that flips it runs OCR (the sync on_inbound run and the queue re-run race; concurrency 2). A loser re-reads and reuses the final `ocrText` (or skips if still processing).
- **Cache**: `ocrStatus='ok'` short-circuits OCR (a #3 re-run reuses it). Recognized text is appended to `replies`, each prefixed so `rawSnippet` marks it as attachment-derived.
- **Scope (codex)**: v1 covers push-path stored media (`tg-listen` -> `persistInboundMedia` with `messageId`). `conversation-sync` only writes `Message.attachments` JSON and stores no bytes, so synced media-only replies have no `MediaAsset` to OCR — documented as a follow-up (sync byte-backfill), not silently handled.

### D4 — Pre-gate accounts for attachments
The pre-gate runs on text today and would skip an attachment-only reply. When the flags are on AND the message has an OCR-able asset, skip the text pre-gate (or run it on text∪ocrText). Rationale: the whole point is to NOT drop attachment-only replies; the OCR call itself is the gate (empty/garbage OCR → empty extraction → `empty` status from #3).

### D5 — Provenance via rawSnippet marker (no new FK this change)
Attachment-derived points are marked in `rawSnippet`. A first-class `ProfileDataPoint.sourceMediaAssetId` FK is deferred — the extractors transcribe attachment text into the same `replies` array and don't track per-reply asset ids; the marker + the message's asset list is enough for the operator. (If per-asset attribution is later needed, it composes with the EAV revision work.)

## Risks / Trade-offs

- **OCR cost / latency on the inbound hot path** → Mitigation: double-gated (off by default); cached per asset (run-once, atomic claim); only IMAGE assets, capped (≤3/msg, ≤5MB, ≤1536px, ≤4000 OCR chars); the sync on_inbound path already tolerates extraction latency, and failures degrade to `ocrStatus='failed'` without aborting inbound.
- **Prompt-injection via attachment text** → Mitigation: same posture as chat text — OCR text feeds the read-only extractors (not the composer); the extractors already instruct «emit only facts present in source». Operator hints (#3) remain advisory.
- **Vision model hallucinates prices not in the image** → Mitigation: OCR agent is prompted to TRANSCRIBE verbatim, low temperature; extractor confidence + the 0.2 floor + operator re-run/correction (#3) catch bad output; attachment-derived facts are marked for review.
- **Provider lacks image support / wrong model** → Mitigation: `images` is ignored by non-OpenRouter providers; OCR model id is in `agent_config`; a failed vision call → `ocrStatus='failed'`, extraction proceeds on text.
- **Large images blow the token budget** → Mitigation: cap image count/size; downscale before encoding (worker-side); one asset per inbound is the common case.

## Migration Plan

Migration `9d_attachment_ocr`: add `media_asset.ocr_text TEXT` + `ocr_status TEXT DEFAULT 'pending'`. No backfill (existing assets stay `pending`; OCR runs lazily on next extraction/re-run). Seed the `media_ocr_extractor` `agent_config`. Add `attachment_ocr` to `FEATURE_FLAG_DEFAULTS` (off) + a `feature_flag` row. Rollback = revert + drop columns; cached OCR text is just discarded.

## Open Questions

- Default vision model id (an OpenRouter multimodal model) — set in seed, tunable in `agent_config`.
- PDF support entirely (OpenRouter `type:'file'` + parser plugin) is a v1 follow-up; v1 marks `application/pdf` as `unsupported`.
- Image downscale threshold (proposed: longest side ≤ 1536px) — tune from cost data.
