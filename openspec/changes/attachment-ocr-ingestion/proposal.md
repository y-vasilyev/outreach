## Why

Bloggers routinely send their price list / media kit as a PDF, a screenshot, or an image instead of plain text. Today those bytes are stored to S3 as a `MediaAsset` but their CONTENT never reaches extraction — the worker feeds only `message.text` to the extractors, so an attachment-only reply produces ZERO catalog data and the pre-gate even skips it as `no_signal`. This change reads attachments (vision OCR via OpenRouter multimodal, per the chosen provider) and feeds the recognized text into the existing extractors, so prices/reach inside a file land in the catalog like any other reply.

## What Changes

- **Multimodal LLM request.** `CompletionRequest` gains an optional `images: { url }[]` (data-URL or http) field; ONLY the OpenRouter provider renders multimodal content parts (`text` + `image_url`) when images are present. Because `openai_compat` reuses OpenRouter's call helper, multimodal rendering MUST be guarded to OpenRouter so other providers stay text-only. Text-only behavior is byte-identical when `images` is absent.
- **OCR agent (images only in v1).** A new `media_ocr_extractor` agent (vision) transcribes an attachment IMAGE (PNG/JPEG/WebP/GIF) to plain text + a kind hint, run via `AgentRunner`. **PDFs are out of scope for v1** — `application/pdf` and any non-image mime are marked `ocrStatus='unsupported'` (OpenRouter PDFs need a different `type:'file'` shape + parser; a follow-up). **The OCR agent input persisted to `agent_run.input` is METADATA ONLY** (`assetId`, `mime`, `bytes`, `sha256`); the base64 data-URL flows to the provider via a non-persisted side channel so huge/private bytes never land in the DB.
- **OCR feeds the existing extractors.** `profile-extract` looks up the source message's image `MediaAsset`s (push-path stored bytes; conversation-sync media backfill is a follow-up), OCRs each, and APPENDS the recognized text (capped) to the extractor `replies`. OCR runs BEFORE the empty/pre-gate short-circuits, so attachment-only replies are no longer skipped as `no_signal`.
- **Provenance + caching + single-run.** `MediaAsset` gains `ocrText` and `ocrStatus` (`pending|processing|ok|failed|unsupported`). An atomic claim (`updateMany WHERE ocr_status IN (pending,failed) SET processing`) prevents the sync+queue double-run both paying for OCR; a re-run from `operator-reanalyze-and-markup` reuses cached `ok` text. Attachment-derived facts are marked in their `rawSnippet` (e.g. prefixed «[из вложения]») so an operator can tell them from chat-text facts.
- **Flag + storage gating.** Behind a new `attachment_ocr` runtime flag (default off). Requires `object_storage` (bytes come from S3); when storage is off or the flag is off, behavior is exactly as today (text-only).

## Capabilities

### New Capabilities

- `attachment-ocr`: vision OCR of inbound attachments (image/PDF) whose recognized text feeds the existing extractors, with per-asset caching and provenance.

### Modified Capabilities

- `agency-sourcing-pipeline`: profile-extract OCRs the source message's attachments and includes their text in extraction; the pre-gate accounts for attachment-derived signal.
- `blogger-commercial-profile`: attachment-derived data points are marked in `rawSnippet`; `MediaAsset` exposes `ocrStatus` so the UI can show «распознано/не удалось».

## Impact

- **DB migration `9d_attachment_ocr`**: add `media_asset.ocr_text` (Text?) + `media_asset.ocr_status` (default `pending`).
- **packages/llm**: `CompletionRequest.images`; OpenRouter provider multimodal content; types + a vision-capable default model id for OCR.
- **packages/agents**: new `media_ocr_extractor` agent + an `invokeVisionText` runtime helper that passes `images` through `ctx.llm.complete`; registry + seed.
- **packages/shared**: `attachment_ocr` flag in `FEATURE_FLAG_DEFAULTS`; OCR result schema; helper to build a data-URL from bytes+mime.
- **apps/workers**: `profile-extract` (or a small `attachment-ocr` service) downloads asset bytes (reusing the media-store/tg-client path), runs the OCR agent, caches `ocrText`/`ocrStatus`, appends text to `replies`. Behind `attachment_ocr` + `object_storage`.
- **packages/db**: schema + migration + `agent_config` seed for `media_ocr_extractor`.
- **apps/api / apps/web**: read surfaces `ocrStatus` on the asset (badge); full attachment-preview UI is `blogger-profile-who-is-this`.
- **Compatibility**: additive + double-gated (flag + storage). No change to text replies, non-OCR flows, or providers without image support. Cost is accounted per OCR `agent_run`.
