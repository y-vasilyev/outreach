## 1. DB + flag (packages/db, packages/shared)

- [ ] 1.1 Add `ocrText String? @map("ocr_text")` + `ocrStatus String? @default("pending") @map("ocr_status")` to `MediaAsset` in `schema.prisma`.
- [ ] 1.2 Migration `9d_attachment_ocr` (sorts after `9c_*`): the two `media_asset` columns; `pnpm db:migrate`.
- [ ] 1.3 Add `attachment_ocr: false` to `FEATURE_FLAG_DEFAULTS` + a `feature_flag` seed row.

## 2. LLM multimodal (packages/llm)

- [ ] 2.1 Add `images?: Array<{ url: string }>` to `CompletionRequest`.
- [ ] 2.2 Multimodal content build in the OpenRouter provider ONLY (guard so the shared `doOpenAICompatCall` does not send images for `openai_compat`): when `images` non-empty, `content` = `[{type:'text',text}, {type:'image_url',image_url:{url}}…]`; else string content. Yandex/openai_compat stay text-only.
- [ ] 2.3 Tests: text-only body byte-identical (snapshot); OpenRouter+images → multimodal parts; openai_compat/Yandex stay string content even with images set.

## 3. OCR agent (packages/agents)

- [ ] 3.1 Add `invokeVisionText(ctx, { userPrompt, images, fallbackSystemPrompt })` that passes `images` to `ctx.llm.complete` as a runtime SIDE CHANNEL (images are NOT part of the agent input AgentRunner persists). Verify `AgentRunner.persistRun` records only metadata, not base64; truncate any stray `images[].url` it sees.
- [ ] 3.2 New `media_ocr_extractor` agent: INPUT is metadata only `{assetId, mime, bytes, sha256}`; transcribe verbatim text + one-word `kind` hint; low temperature; default vision OpenRouter model id; register in `registry.ts`. Prompt: transcribe ONLY what is visible; do not invent.
- [ ] 3.3 Helper `bytesToDataUrl(bytes, mime)` (in shared). HARD LIMITS as acceptance criteria: ≤3 image assets/message, ≤5MB/asset, supported mimes png/jpeg/webp/gif, ≤4000 OCR chars appended to replies; downscale longest side to ≤1536px before encoding.
- [ ] 3.4 Test: agent calls `complete` with images; returns transcribed text (mocked LLM).

## 4. Worker: OCR feeds extraction (apps/workers)

- [ ] 4.0 Add `ObjectStore.getObject(key): Promise<Uint8Array>` (no download method exists today); prefer it for bytes, fall back to the tg-client `downloadInboundMedia` path for metadata-only assets.
- [ ] 4.1 In `profile-extract`, behind `attachment_ocr` + `object_storage`: select the source message's OCR-able image assets (`s3Key!=''`, image mime — infer `image/jpeg` for TG photos whose mime is null; non-image → mark `unsupported`; exclude `raw_payload`); ATOMICALLY CLAIM each (`updateMany WHERE id=? AND ocr_status IN (pending,failed) SET processing`) before OCR; the claimer fetches bytes, builds the data-URL, runs `media_ocr_extractor`, writes `ocrText`/`ocrStatus` (`ok`/`failed`/`unsupported`); a non-claimer reuses the cached result.
- [ ] 4.2 Append recognized texts to `replies`, each prefixed «[из вложения] » so extractor `rawSnippet`s mark attachment-derived facts.
- [ ] 4.3 Order: resolve message -> OCR assets -> build `combinedText = text + ocrTexts` -> run empty/pre-gate on `combinedText` (so attachment-only replies are not skipped).
- [ ] 4.4 Idempotency: reuse cached `ocrText` when `ocrStatus='ok'` (a #3 re-run does not re-pay OCR). Degrade safely — OCR failure never aborts inbound.
- [ ] 4.5 Tests: attachment-only reply → OCR runs, text extracted, not pre-gated; cached OCR reused on re-run; OCR failure → `ocrStatus='failed'`, extraction continues; flags off → no OCR.

## 5. Read + seed

- [ ] 5.1 Surface `ocrStatus` on the asset read (message attachments + profile media list).
- [ ] 5.2 Seed `media_ocr_extractor` `agent_config`.

## 6. Verification

- [ ] 6.1 `pnpm db:migrate` applies (last in lexical order); `pnpm typecheck && pnpm lint && pnpm test` green.
- [ ] 6.2 Update `CHANGELOG.md` (operator-visible: prices/reach inside PDFs/screenshots now reach the catalog).
- [ ] 6.3 `openspec validate attachment-ocr-ingestion --strict` passes.
