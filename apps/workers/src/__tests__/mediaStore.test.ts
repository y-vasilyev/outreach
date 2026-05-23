import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const prisma = {
    bloggerProfile: { findUnique: vi.fn() },
    mediaAsset: { create: vi.fn(), update: vi.fn() },
  };
  // Runtime feature-flag state (object_storage off by default here).
  const flagState: Record<string, boolean> = {};
  return { prisma, flagState };
});

vi.mock('../feature-flags.js', () => ({
  getFeatureFlags: () => ({ get: (k: string) => mocks.flagState[k] ?? false }),
}));
vi.mock('@nosquare/db', () => ({ getPrisma: () => mocks.prisma }));

import { persistInboundMedia, snapshotRawPayload } from '../services/media-store.js';

describe('persistInboundMedia degrades safely when storage is disabled', () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.flagState.object_storage = false;
  });

  it('does NOT throw and does NOT write a media_asset when the flag is off', async () => {
    mocks.flagState.object_storage = false;
    const res = await persistInboundMedia({
      conversationId: 'c1',
      channelId: 'ch1',
      sourceTgMsgId: '42',
      media: { className: 'MessageMediaDocument', kind: 'document', mime: 'application/pdf' },
    });
    expect(res.persisted).toBe(false);
    expect(res.degraded).toBe('flag_off');
    expect(mocks.prisma.mediaAsset.create).not.toHaveBeenCalled();
  });

  it('snapshotRawPayload returns null (no throw) when the flag is off', async () => {
    mocks.flagState.object_storage = false;
    const key = await snapshotRawPayload({
      conversationId: 'c1',
      sourceMessageId: 'm1',
      rawText: 'verbatim',
      parsed: { x: 1 },
    });
    expect(key).toBeNull();
  });
});
