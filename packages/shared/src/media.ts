/**
 * Attachment-OCR helpers (attachment-ocr-ingestion). Hard limits + mime
 * handling shared by the worker. Kept dependency-free.
 */

/** Image mimes the OCR vision path accepts (OpenRouter image inputs). */
export const OCR_SUPPORTED_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

/** Hard caps (acceptance criteria) for OCR on the inbound hot path. */
export const OCR_MAX_ASSETS_PER_MESSAGE = 3;
export const OCR_MAX_BYTES = 5 * 1024 * 1024; // 5 MB per asset
export const OCR_MAX_TEXT_CHARS = 4000; // appended to replies per asset

/**
 * Resolve a usable image mime for OCR, or null when the asset is not an
 * OCR-able image (→ caller marks `ocrStatus='unsupported'`). Telegram photos
 * are stored with `mime = null` and an image kind; we default those to
 * `image/jpeg`. Documents/PDFs and unknown mimes are rejected in v1.
 */
export function ocrImageMime(kind: string | null | undefined, mime: string | null | undefined): string | null {
  const m = (mime ?? '').toLowerCase();
  if (m && (OCR_SUPPORTED_MIMES as readonly string[]).includes(m)) return m;
  if (!m && (kind === 'image' || kind === 'screenshot' || kind === 'media_kit')) {
    return 'image/jpeg'; // TG photos: no mime, image kind → JPEG
  }
  return null;
}

/** Base64 data-URL from raw bytes + mime (worker-side; bytes from S3/tg-client). */
export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  const b64 = Buffer.from(bytes).toString('base64');
  return `data:${mime};base64,${b64}`;
}
