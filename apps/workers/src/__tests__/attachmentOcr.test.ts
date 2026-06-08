import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const prisma = {
    mediaAsset: { findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    message: { findUnique: vi.fn() },
  };
  const runAgentSafe = vi.fn();
  const getObject = vi.fn();
  const flagState: Record<string, boolean> = {};
  return { prisma, runAgentSafe, getObject, flagState };
});

vi.mock('@nosquare/db', () => ({ getPrisma: () => mocks.prisma }));
vi.mock('@nosquare/storage', () => ({ getObjectStore: () => ({ getObject: mocks.getObject }) }));
vi.mock('../services/run-agent-safe.js', () => ({ runAgentSafe: mocks.runAgentSafe }));
vi.mock('../feature-flags.js', () => ({
  getFeatureFlags: () => ({ get: (k: string) => mocks.flagState[k] ?? false }),
}));
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { ocrMessageAttachments } from '../services/attachment-ocr.js';

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(mocks.flagState)) delete mocks.flagState[k];
  mocks.prisma.mediaAsset.update.mockResolvedValue({});
  mocks.prisma.mediaAsset.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.message.findUnique.mockResolvedValue({ tgMsgId: null });
  mocks.getObject.mockResolvedValue(new Uint8Array([1, 2, 3]));
});

const imageAsset = { id: 'a1', kind: 'screenshot', mime: 'image/png', s3Key: 'k1', sha256: 'h', ocrStatus: 'pending', ocrText: null };

describe('ocrMessageAttachments (attachment-ocr-ingestion)', () => {
  it('returns [] when the flag is off (no DB access)', async () => {
    const out = await ocrMessageAttachments({ conversationId: 'c', messageId: 'm' });
    expect(out).toEqual([]);
    expect(mocks.prisma.mediaAsset.findMany).not.toHaveBeenCalled();
  });

  it('claims, OCRs, caches, and returns the recognized text', async () => {
    mocks.flagState.attachment_ocr = true;
    mocks.flagState.object_storage = true;
    mocks.prisma.mediaAsset.findMany.mockResolvedValue([imageAsset]);
    mocks.runAgentSafe.mockResolvedValue({ text: 'Фото-пост 120000' });

    const out = await ocrMessageAttachments({ conversationId: 'c', messageId: 'm' });
    expect(out).toEqual(['Фото-пост 120000']);
    // atomic claim before OCR
    expect(mocks.prisma.mediaAsset.updateMany).toHaveBeenCalled();
    // OCR agent ran with a data-URL image (redaction happens in AgentRunner)
    const call = mocks.runAgentSafe.mock.calls[0]!;
    expect(call[0]).toBe('media_ocr_extractor');
    expect((call[1] as { images: Array<{ url: string }> }).images[0]!.url.startsWith('data:image/png;base64,')).toBe(true);
    // cached ok
    expect(mocks.prisma.mediaAsset.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ocrStatus: 'ok', ocrText: 'Фото-пост 120000' }) }),
    );
  });

  it('reuses cached ocrText without re-running OCR', async () => {
    mocks.flagState.attachment_ocr = true;
    mocks.flagState.object_storage = true;
    mocks.prisma.mediaAsset.findMany.mockResolvedValue([{ ...imageAsset, ocrStatus: 'ok', ocrText: 'cached' }]);
    const out = await ocrMessageAttachments({ conversationId: 'c', messageId: 'm' });
    expect(out).toEqual(['cached']);
    expect(mocks.runAgentSafe).not.toHaveBeenCalled();
  });

  it('marks a PDF unsupported (v1) and skips it', async () => {
    mocks.flagState.attachment_ocr = true;
    mocks.flagState.object_storage = true;
    mocks.prisma.mediaAsset.findMany.mockResolvedValue([{ ...imageAsset, mime: 'application/pdf' }]);
    const out = await ocrMessageAttachments({ conversationId: 'c', messageId: 'm' });
    expect(out).toEqual([]);
    expect(mocks.prisma.mediaAsset.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { ocrStatus: 'unsupported' } }),
    );
    expect(mocks.runAgentSafe).not.toHaveBeenCalled();
  });

  it('on a lost claim, reuses the winner’s cached result', async () => {
    mocks.flagState.attachment_ocr = true;
    mocks.flagState.object_storage = true;
    mocks.prisma.mediaAsset.findMany.mockResolvedValue([imageAsset]);
    mocks.prisma.mediaAsset.updateMany.mockResolvedValue({ count: 0 }); // lost the claim
    mocks.prisma.mediaAsset.findUnique.mockResolvedValue({ ocrStatus: 'ok', ocrText: 'by winner' });
    const out = await ocrMessageAttachments({ conversationId: 'c', messageId: 'm' });
    expect(out).toEqual(['by winner']);
    expect(mocks.runAgentSafe).not.toHaveBeenCalled();
  });

  it('marks a known-oversized image unsupported WITHOUT downloading it', async () => {
    mocks.flagState.attachment_ocr = true;
    mocks.flagState.object_storage = true;
    mocks.prisma.mediaAsset.findMany.mockResolvedValue([{ ...imageAsset, bytes: 50 * 1024 * 1024 }]);
    const out = await ocrMessageAttachments({ conversationId: 'c', messageId: 'm' });
    expect(out).toEqual([]);
    expect(mocks.getObject).not.toHaveBeenCalled();
    expect(mocks.prisma.mediaAsset.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { ocrStatus: 'unsupported' } }),
    );
  });

  it('OCR failure → marks failed, returns no text, does not throw', async () => {
    mocks.flagState.attachment_ocr = true;
    mocks.flagState.object_storage = true;
    mocks.prisma.mediaAsset.findMany.mockResolvedValue([imageAsset]);
    mocks.getObject.mockRejectedValue(new Error('s3 down'));
    const out = await ocrMessageAttachments({ conversationId: 'c', messageId: 'm' });
    expect(out).toEqual([]);
    expect(mocks.prisma.mediaAsset.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { ocrStatus: 'failed' } }),
    );
  });
});
