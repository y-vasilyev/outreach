import { describe, it, expect } from 'vitest';
import { ocrImageMime, bytesToDataUrl, OCR_SUPPORTED_MIMES } from '../media.js';

describe('ocrImageMime (attachment-ocr-ingestion)', () => {
  it('accepts supported image mimes', () => {
    for (const m of OCR_SUPPORTED_MIMES) expect(ocrImageMime('other', m)).toBe(m);
  });
  it('defaults null-mime image/screenshot/media_kit to image/jpeg (TG photos)', () => {
    expect(ocrImageMime('image', null)).toBe('image/jpeg');
    expect(ocrImageMime('screenshot', undefined)).toBe('image/jpeg');
    expect(ocrImageMime('media_kit', null)).toBe('image/jpeg');
  });
  it('rejects PDFs and unknown doc mimes (unsupported in v1)', () => {
    expect(ocrImageMime('media_kit', 'application/pdf')).toBeNull();
    expect(ocrImageMime('other', 'text/plain')).toBeNull();
    expect(ocrImageMime('raw_payload', 'application/json')).toBeNull();
  });
});

describe('bytesToDataUrl', () => {
  it('builds a base64 data-URL', () => {
    const url = bytesToDataUrl(new Uint8Array([1, 2, 3]), 'image/png');
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
    expect(url).toBe(`data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`);
  });
});
