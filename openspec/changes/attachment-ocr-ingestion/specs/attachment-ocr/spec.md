## ADDED Requirements

### Requirement: Inbound attachments are OCR'd into extraction

When `attachment_ocr` and `object_storage` are on and an inbound message carries an IMAGE `MediaAsset` (PNG/JPEG/WebP/GIF; PDFs are `unsupported` in v1), the profile-extract pipeline SHALL download the asset bytes, run a vision OCR agent (`media_ocr_extractor`) to recognize its text, and append that text to the extractor `replies` so the existing rate/audience extractors structure it. The OCR result SHALL be cached on the asset (`ocrText`, `ocrStatus`), so a re-run reuses it rather than re-paying for OCR. An attachment the OCR cannot handle (incl. PDFs in v1) SHALL be marked `ocrStatus='unsupported'` (not silently dropped). The OCR agent's persisted `agent_run.input` SHALL be metadata only (no base64 bytes), and a concurrent sync+queue run SHALL OCR each asset at most once (atomic claim).

#### Scenario: A price-list screenshot lands in the catalog

- **WHEN** a blogger replies with only a screenshot of their price list and the flags are on
- **THEN** the attachment is OCR'd, its text feeds the extractors, and the prices appear in the profile — instead of the reply being skipped as `no_signal`

#### Scenario: OCR is cached per asset

- **WHEN** extraction runs twice for the same message+attachment
- **THEN** OCR runs once; the second run reuses the cached `ocrText`

#### Scenario: Unsupported attachment is marked, not dropped

- **WHEN** an attachment type the OCR path cannot process arrives
- **THEN** its `ocrStatus` is `unsupported` and extraction proceeds on the text (if any) without error

### Requirement: Multimodal request is opt-in and provider-safe

`CompletionRequest` SHALL support an optional `images` list; the OpenRouter provider SHALL render multimodal content parts when it is non-empty. When `images` is absent the request SHALL be byte-identical to today, and a provider without image support SHALL NOT fail on a text-only request. OCR SHALL run via `AgentRunner` so it writes an accounted `agent_run`.

#### Scenario: Text-only requests unchanged

- **WHEN** a normal text agent runs (no images)
- **THEN** the provider request body is identical to before this change

#### Scenario: OCR cost is accounted

- **WHEN** the OCR agent runs
- **THEN** an `agent_run` row records its tokens/cost like any other agent call

### Requirement: Attachment-derived facts are distinguishable

Data points extracted from attachment text SHALL be marked in their `rawSnippet` (e.g. a «[из вложения]» prefix); the extractor SHALL treat OCR text as untrusted quoted evidence (transcription, not instructions); the asset's `ocrStatus` SHALL be exposed on the read API.

#### Scenario: Operator sees the source

- **WHEN** a price was extracted from a media-kit PDF
- **THEN** the data point's `rawSnippet` indicates it came from an attachment, and the asset shows `ocrStatus='ok'`
