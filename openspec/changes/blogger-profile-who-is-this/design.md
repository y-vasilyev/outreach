## Context

`BloggerProfilePage.vue` + `BloggerCatalogPage.vue` already render the rolled-up profile (rates, audience map, top-posts as text+metrics, media-kit downloads, data-points provenance). `BloggerPostInsight` has `url`/`textSnippet`/`metrics` but NO image. Inbound attachment images render via `AttachmentImage.vue` (presigned `GET /media-assets/:id/download-url` + an on-error fallback). The operator backend from `operator-reanalyze-and-markup` (reanalyze, data-point write/delete, hints, `message.extraction_status.changed`) and the `attachment-ocr` `ocrStatus` exist but have no UI. `platformAudience` + v2 terms (`placement-representation-v2`) are in the read model but not rendered.

## Goals / Non-Goals

**Goals:**
- See WHO a blogger is: post-example images, per-platform audience, real deal terms.
- Search + compare the catalog standalone (Path A).
- Wire the existing operator backend (re-run/status/correct/hints/OCR-status) to the UI.
- Public imagery only; additive + flag-gated.

**Non-Goals:**
- The EAV /bloggers catalog rebuild (Phase-4 `blogger-aggregate-and-catalog`) — this enriches the existing pages, it does not replace them.
- New extraction logic (done in #1–#4).

## Decisions

### D1 — Post images are platform-scoped (codex blocker)
The normalized scrape contracts (`ChannelSnapshotPost`) have NO preview image (`platforms/src/types.ts:45`); Telegram drops media, Instagram/YouTube `urls` are text-extracted links. So: extend the platform contract with `previewImageUrl?`/`publicMediaRef?`; **YouTube** sets a deterministic public thumbnail URL from the video id (no download — served directly, `imageStatus='ok'` with a URL not an s3 key); **Telegram** uses a NEW `downloadPublicPostMedia` to fetch the public post photo and `putObject` it under a SAFE key `bloggers/{profileId}/posts/{platform}/{encodeURIComponent(externalPostId)}` (platform is part of the post identity, raw ids aren't path-safe — codex); **others** → `unsupported`. Read exposes `hasImage`/`imageStatus`, never the key.

### D2 — Image endpoint: existence-checked presign + public repair (codex)
The existing presign service does not check object existence. Add `ObjectStore.headObject(key)` (cheap HEAD). `GET /blogger-post-insights/:id/image-url`: 404 when the insight is missing; 409 when `unsupported`/no image/storage off; for a YouTube thumbnail return the public URL directly; for Telegram, `headObject` the key and presign when present, else repair via `downloadPublicPostMedia` then presign (502 on refetch failure). `downloadPublicPostMedia` is a NEW public method — `downloadInboundMedia` is inbound-DM/session-bound and must NOT be reused (codex).

### D3 — A reusable `S3Image` web component
Generalize `AttachmentImage.vue` into `S3Image` taking a `urlFetcher` (the endpoint to call) + an on-error fallback state. Used for both inbound attachments and post images. Rationale: one place for presign + fallback + «preview unavailable».

### D4 — Catalog search + compare are client-side over the existing list
The catalog already loads up to 200 profiles with rates/audience/fit. Add a search box (client filter over name/topic/handle) and a compare mode: checkboxes select 2–4 rows → a side-by-side panel reads the already-loaded profile fields (platformAudience, prices per format, formats, freshness). Rationale: no new API; instant; the standalone compare the operator needs. (Server-side search/keyset pagination is the Phase-4 catalog's job.)

### D5 — Operator controls call the existing endpoints
Inbox message row: status badge from `message.extractionStatus`; «Переанализировать» → `POST …/reanalyze`; live update via the `message.extraction_status.changed` socket event. Profile data-points table: an edit (operator data-point write) + delete; a hint form (`POST /extraction-hints`). OCR chip from the attachment `ocrStatus`. Rationale: the backend is done and tested; this is wiring + components, behind `agency_sourcing`.

## Risks / Trade-offs

- **Post-image storage cost / fetching public media** → Mitigation: behind `object_storage`; one preview image per top post; only PUBLIC sources; deterministic key (overwrite, not accumulate).
- **TG-parser refetch latency on image load** → Mitigation: only on a cache miss; presigned URL is cached client-side for its TTL; failure shows the text snippet, never a broken image.
- **Client-side compare doesn't scale past the loaded page** → Mitigation: explicitly the standalone-compare-of-the-current-list use case; large-scale catalog search is deferred to Phase-4. Documented.
- **Operator correction UI could write malformed values** → Mitigation: the field-aware write schema (#3) already validates/rejects; the UI surfaces the error.

## Migration Plan

`9e_blogger_post_images`: add the two `blogger_post_insight` columns (defaults so existing rows are valid). No backfill; images populate on the next post-insight refresh. Rollback = revert + drop. UI is additive — flags off ⇒ today's text-only profile.

## Open Questions

- Whether to store a downscaled thumbnail vs the full preview (leaning a bounded preview ≤ 1024px).
- Compare max width (2–4 bloggers) — 4 proposed; tune from real screens.
