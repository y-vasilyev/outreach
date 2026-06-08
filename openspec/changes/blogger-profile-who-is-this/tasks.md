## 1. DB + schema (packages/db, packages/shared)

- [x] 1.1 Add `imageS3Key String? @map("image_s3_key")` + `imageStatus String? @default("pending") @map("image_status")` to `BloggerPostInsight`.
- [x] 1.2 Migration `9e_blogger_post_images` (after `9d_*`); `pnpm db:migrate`.
- [x] 1.3 `BloggerPostInsightZ`/preview schema: add `hasImage: boolean` + `imageStatus` (never expose the raw s3 key).

## 2. Platform media contract + Telegram public downloader (packages/platforms, packages/tg-client, apps/workers)

- [ ] 2.0 Extend the platform post contract (`ChannelSnapshotPost`/adapters) with `previewImageUrl?` (e.g. YouTube thumbnail by video id) and `publicMediaRef?` (Telegram handle+postId).
- [ ] 2.1 NEW `downloadPublicPostMedia({ handle, postId })` in tg-client (parser accounts only): resolve the PUBLIC channel post and download its photo/image-document bytes. Distinct from `downloadInboundMedia` (inbound-DM-bound).
- [ ] 2.2 In post-insight refresh: YouTube → set `imageStatus='ok'` + the public thumbnail URL (no storage); Telegram → `downloadPublicPostMedia` → `putObject` under a SAFE key `bloggers/{profileId}/posts/{platform}/{encodeURIComponent(externalPostId)}` → `imageStatus='ok'`; others/no media → `unsupported`; error → `failed`. Degrade safely.
- [ ] 2.3 Tests: Telegram post → image stored + status ok; Telegram no-media → unsupported; YouTube → thumbnail URL + ok; Instagram/ScrapeCreators → unsupported (no media field).

## 3. API: image endpoint + read + DTO threading (apps/api)

- [x] 3.0 Add `ObjectStore.headObject(key): Promise<boolean>` (cheap existence check).
- [ ] 3.1 `GET /blogger-post-insights/:id/image-url`: 404 insight-missing; 409 unsupported/no-image/storage-off; YouTube → return the public thumbnail URL; Telegram → headObject + presign, else repair via `downloadPublicPostMedia` then presign (502 on refetch failure).
- [x] 3.2 Profile read: `hasImage`/`imageStatus` on top posts (never the key); thread `ocrStatus` into message `attachments` enrichment (`conversations.getMessages` copies only `assetId` today) and profile media DTO.
- [x] 3.3 Add `requireFeature('agency_sourcing')` to `operatorMarkupRoutes` (drift fix: they were role-gated only, but the operator-reanalyze-and-markup spec said agency-gated).
- [ ] 3.4 Tests: image-url presigns when present; missing Telegram object triggers repair; unsupported → 409; ocrStatus present on a message attachment.

## 4. Web: profile card (apps/web)

- [ ] 4.1 Generalize `AttachmentImage` → a reusable `S3Image` (urlFetcher + fallback state); use it for inbound attachments (no behavior change) and post images.
- [ ] 4.2 `BloggerProfilePage`: post-example image gallery (S3Image) + per-platform audience table (`platformAudience`) + v2 placement terms (tariff/slot/season/prepayment/tax) on offers.
- [ ] 4.3 Web test: post gallery renders images via the fetcher; per-platform audience shows.

## 5. Web: catalog search + compare (apps/web)

- [ ] 5.1 `BloggerCatalogPage`: free-text search (name/topic/handle) client filter.
- [ ] 5.2 Compare mode: select 2–4 bloggers → a side-by-side panel (per-platform audience, prices per format, formats, freshness).
- [ ] 5.3 Web test: search filters; compare renders selected bloggers side by side.

## 6. Web: operator controls (apps/web) — wire the existing backend

- [ ] 6.0 Add `message.extraction_status.changed` to web `RealtimeEvents` + subscribe in `ConversationView` (patch the message in cache / invalidate `conversation-messages`); add `ocrStatus` to web `MessageAttachment`/`MediaAsset` types.
- [ ] 6.1 Inbox message row: extraction-status badge + «Переанализировать» button (`POST …/reanalyze`); live update on `message.extraction_status.changed`.
- [ ] 6.2 Profile data-points table: inline correct (operator data-point write) + delete control.
- [ ] 6.3 Extraction-hint form (create a hint, scope channel/conversation/global) from a failed/empty message or the profile.
- [ ] 6.4 Attachment chip: show `ocrStatus` («распознано/не удалось»).
- [ ] 6.5 Web tests for the status badge + reanalyze action + correction.

## 7. Verification

- [ ] 7.1 `pnpm db:migrate` applies (last in lexical order); `pnpm typecheck && pnpm lint && pnpm test` green.
- [ ] 7.2 Update `CHANGELOG.md` (operator-visible: see who a blogger is — post images, per-platform audience, search+compare, re-run/fix/teach in the UI).
- [ ] 7.3 `openspec validate blogger-profile-who-is-this --strict` passes.
