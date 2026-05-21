import { afterEach, describe, expect, it, vi } from 'vitest';
import { flags as readonlyFlags } from '@nosquare/shared';

const flags = readonlyFlags as unknown as { ENABLE_OBJECT_STORAGE: boolean };

const mocks = vi.hoisted(() => {
  const prisma = {
    bloggerProfile: { findUnique: vi.fn() },
    mediaAsset: { create: vi.fn(), update: vi.fn() },
  };
  return { prisma };
});

vi.mock('@nosquare/db', () => ({ getPrisma: () => mocks.prisma }));

import { persistInboundMedia, snapshotRawPayload } from '../services/media-store.js';

describe('persistInboundMedia degrades safely when storage is disabled', () => {
  afterEach(() => {
    vi.clearAllMocks();
    flags.ENABLE_OBJECT_STORAGE = false;
  });

  it('does NOT throw and does NOT write a media_asset when the flag is off', async () => {
    flags.ENABLE_OBJECT_STORAGE = false;
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
    flags.ENABLE_OBJECT_STORAGE = false;
    const key = await snapshotRawPayload({
      conversationId: 'c1',
      sourceMessageId: 'm1',
      rawText: 'verbatim',
      parsed: { x: 1 },
    });
    expect(key).toBeNull();
  });
});
