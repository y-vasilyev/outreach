import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const prisma = {
    bloggerPostInsight: { findUnique: vi.fn(), update: vi.fn() },
  };
  const putObject = vi.fn();
  const downloadPublicPostMedia = vi.fn();
  const flagState: Record<string, boolean> = {};
  return { prisma, putObject, downloadPublicPostMedia, flagState };
});

vi.mock('@nosquare/db', () => ({ getPrisma: () => mocks.prisma }));
vi.mock('@nosquare/storage', () => ({ getObjectStore: () => ({ putObject: mocks.putObject }) }));
vi.mock('../feature-flags.js', () => ({
  getFeatureFlags: () => ({ get: (k: string) => mocks.flagState[k] ?? false }),
}));
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { storeTelegramPostImages } from '../services/post-images.js';

const tg = { downloadPublicPostMedia: mocks.downloadPublicPostMedia };

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(mocks.flagState)) delete mocks.flagState[k];
  mocks.prisma.bloggerPostInsight.findUnique.mockResolvedValue({ imageStatus: 'pending' });
  mocks.prisma.bloggerPostInsight.update.mockResolvedValue({});
});

describe('storeTelegramPostImages (blogger-profile-who-is-this)', () => {
  it('returns early when object_storage is off', async () => {
    const out = await storeTelegramPostImages({ profileId: 'p', handle: 'h', posts: [{ id: '1' }], tg });
    expect(out.stored).toBe(0);
    expect(mocks.downloadPublicPostMedia).not.toHaveBeenCalled();
  });

  it('downloads + stores a post photo and marks the insight ok', async () => {
    mocks.flagState.object_storage = true;
    mocks.downloadPublicPostMedia.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const out = await storeTelegramPostImages({ profileId: 'p1', handle: 'tomnayaa', posts: [{ id: '42' }], tg });
    expect(out.stored).toBe(1);
    expect(mocks.putObject).toHaveBeenCalledWith(
      'bloggers/p1/posts/telegram/42',
      expect.any(Uint8Array),
      'image/jpeg',
    );
    expect(mocks.prisma.bloggerPostInsight.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { imageS3Key: 'bloggers/p1/posts/telegram/42', imageStatus: 'ok' } }),
    );
  });

  it('marks unsupported when there is no public photo', async () => {
    mocks.flagState.object_storage = true;
    mocks.downloadPublicPostMedia.mockResolvedValue(null);
    const out = await storeTelegramPostImages({ profileId: 'p1', handle: 'h', posts: [{ id: '7' }], tg });
    expect(out.stored).toBe(0);
    expect(mocks.putObject).not.toHaveBeenCalled();
    expect(mocks.prisma.bloggerPostInsight.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { imageStatus: 'unsupported' } }),
    );
  });

  it('skips a post whose image is already ok (cached)', async () => {
    mocks.flagState.object_storage = true;
    mocks.prisma.bloggerPostInsight.findUnique.mockResolvedValue({ imageStatus: 'ok' });
    const out = await storeTelegramPostImages({ profileId: 'p1', handle: 'h', posts: [{ id: '7' }], tg });
    expect(out.stored).toBe(0);
    expect(mocks.downloadPublicPostMedia).not.toHaveBeenCalled();
  });
});
