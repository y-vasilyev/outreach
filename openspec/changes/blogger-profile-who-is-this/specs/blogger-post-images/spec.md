## ADDED Requirements

### Requirement: Post-example images stored in S3 with a TG-parser fallback

`BloggerPostInsight` SHALL carry `imageS3Key` + `imageStatus` (`pending|ok|failed|unsupported`). Post images are sourced per platform (the normalized scrape contracts carry no preview image): YouTube via a deterministic public thumbnail URL from the video id; Telegram via a NEW parser-account public-media method `downloadPublicPostMedia({handle, postId})` storing the photo to S3; other platforms `unsupported` in v1. The profile read SHALL expose a boolean `hasImage` + `imageStatus` (never the raw s3 key). `GET /blogger-post-insights/:id/image-url` SHALL existence-check the object (via `ObjectStore.headObject`) and, on a miss for a Telegram post with a known source id, repair it via `downloadPublicPostMedia` before presigning. Only PUBLIC post imagery is fetched (parser accounts), consistent with the sourcing rules.

#### Scenario: Post image served from S3

- **WHEN** a post insight has `imageStatus='ok'` and an `imageS3Key`
- **THEN** the image-url endpoint returns a presigned URL the UI renders

#### Scenario: Missing Telegram object is repaired via the public downloader

- **WHEN** a Telegram post's S3 object is missing but its handle+postId are known
- **THEN** the API re-fetches the PUBLIC image via `downloadPublicPostMedia`, stores it, and returns the URL — not a broken image

#### Scenario: No public image ⇒ graceful

- **WHEN** a post has no public preview image
- **THEN** `imageStatus='unsupported'` and the UI shows the text snippet without a broken image
