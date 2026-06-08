## Why

The operator runs two jobs: (A) build a blogger base and then SEARCH + COMPARE bloggers standalone, and (B) match to a client brief. Both need to answer «кто этот блогер?» at a glance — but today the profile/catalog show only text + numbers: no post-example IMAGES, per-platform audience isn't rendered, there's no side-by-side compare, and the operator backend from `operator-reanalyze-and-markup` (re-run / status / correct / hints) and the `attachment-ocr` status have no UI. This change makes the blogger visually legible and the catalog actually searchable + comparable, and wires the operator controls.

## What Changes

- **Post-example images, per platform (feasibility-scoped).** `BloggerPostInsight` gains `imageS3Key` + `imageStatus`. The current normalized scrape contracts carry NO post preview image (codex), so v1 sources images as follows: **YouTube** — a deterministic public thumbnail URL derived from the video id (no download/storage needed; served directly); **Telegram** — a NEW parser-account public-media downloader `downloadPublicPostMedia({ handle, postId })` (NOT `downloadInboundMedia`, which is inbound-DM-bound) stores the post photo to S3; **Instagram and others** — `imageStatus='unsupported'` in v1 until a real media field/downloader exists. The platform contract gains an explicit `previewImageUrl?`/`publicMediaRef?` so adapters opt in. The profile renders a post gallery; images load via a presigned URL with an on-demand repair (re-fetch via `downloadPublicPostMedia`) when the S3 object is missing — the «S3 + фоллбэк через ТГ-парсер» flow, now using the right public method. Reuses the `AttachmentImage` presign+fallback pattern.
- **Per-platform audience + commercial terms on the card.** The profile and catalog render `platformAudience` (from `placement-representation-v2`) and the v2 placement terms (tariff/slot/season/prepayment/tax) so the operator sees subscribers per platform and the real deal terms, not one blended number.
- **Catalog search + side-by-side compare (Path A).** The catalog page gains free-text search (name/topic/handle) and a compare mode: select 2–4 bloggers and see a side-by-side table of per-platform audience, prices per format, formats, freshness — for choosing between bloggers without a brief.
- **Operator controls wired to the existing backend.** Inbox: a per-message extraction-status badge + «Переанализировать» button (`operator-reanalyze-and-markup`), reacting to the `message.extraction_status.changed` event. Profile: inline correct/delete on the data-points table (operator data-point write/delete) and an extraction-hint form. Attachments show `ocrStatus` («распознано/не удалось»).

## Capabilities

### New Capabilities

- `blogger-post-images`: store post-example preview images in S3 and serve them with an on-demand TG-parser fallback when the object is missing.
- `catalog-compare`: catalog free-text search + a side-by-side blogger compare view for the standalone base path.

### Modified Capabilities

- `blogger-commercial-profile`: the profile read exposes post-image refs + `imageStatus`; the profile page renders post images, per-platform audience, and v2 terms.
- `agency-sourcing-pipeline`: operator surfaces for re-run/status/correction/hints (UI for the already-built backend) and OCR status.

## Impact

- **DB migration `9e_blogger_post_images`**: `blogger_post_insight.image_s3_key` + `image_status` (default `pending`).
- **packages/db / shared**: `BloggerPostInsight` schema gains `imageS3Key?`/`imageStatus`; post-image status enum.
- **packages/platforms / packages/tg-client / apps/workers**: an explicit platform `previewImageUrl?`/`publicMediaRef?` contract; a NEW tg-client `downloadPublicPostMedia({handle, postId})` for public channel post photos (parser accounts only); post-insight refresh stores the image to S3 with a safe key `bloggers/{profileId}/posts/{platform}/{encoded externalPostId}` and sets `imageStatus`. Degrades safely.
- **apps/api**: `GET /blogger-post-insights/:id/image-url` (existence-checked presign via a new `ObjectStore.headObject`; on a miss, repair via `downloadPublicPostMedia`; 404=insight not found, 409=unsupported/no image/storage off, 502=refetch failed); profile read + message attachments thread `ocrStatus`; add `requireFeature('agency_sourcing')` to the operator-markup routes (they were role-gated only — drift from the operator-reanalyze-and-markup spec).
- **apps/web**: web `RealtimeEvents` + `ConversationView` subscribe to `message.extraction_status.changed`; web `MessageAttachment`/`MediaAsset` types gain `ocrStatus`; `BloggerProfilePage` post-image gallery + per-platform audience + v2 terms + data-point correct/delete + hint form; `BloggerCatalogPage` search (incl. `platformAudience`) + a 2–4 client-side compare (freshness limited to `updatedAt`/top-post); reusable `S3Image` generalized from `AttachmentImage`.
- **Compatibility**: additive. Post images behind `object_storage`; the operator controls behind `agency_sourcing`. No change when flags are off — the profile just shows text as today. Public-post imagery is only ever fetched from public sources (no private data), consistent with the project's sourcing rules.
