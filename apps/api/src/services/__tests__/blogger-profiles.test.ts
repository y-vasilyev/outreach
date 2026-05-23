// Env stubbing runs from vitest's setupFiles in apps/api/vitest.config.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// bloggerProfilesService.get reads a profile with its dataPoints + mediaAssets
// via Prisma. We stub Prisma so we can assert the API-boundary mapping: (a)
// ProfileDataPoint.confidence (a Prisma Decimal — serialized as a string over
// the wire) is coerced to a JS number, and (b) mediaAssets are reduced to safe
// metadata only — never s3Key.
//
// Prisma's Decimal is modeled here as a string (its JSON serialization), which
// is exactly what the boundary coercion `Number(dp.confidence)` must handle.

interface PrismaMock {
  bloggerProfile: { findUnique: ReturnType<typeof vi.fn> };
}

const prismaMock: PrismaMock = {
  bloggerProfile: { findUnique: vi.fn() },
};

vi.mock('@nosquare/db', () => ({
  getPrisma: () => prismaMock,
}));

import { bloggerProfilesService } from '../blogger-profiles.js';

const NOW = new Date('2026-05-20T00:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('bloggerProfilesService.get — API-boundary serialization', () => {
  it('coerces Decimal confidence to a JS number and exposes only safe media metadata', async () => {
    prismaMock.bloggerProfile.findUnique.mockResolvedValue({
      id: 'p1',
      channelId: 'chan_1',
      topics: ['крипта'],
      languages: ['ru'],
      formats: ['пост'],
      audience: {},
      rateCards: [],
      reach: 1000,
      avgViews: 100,
      capturedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
      dataPoints: [
        {
          id: 'dp1',
          profileId: 'p1',
          field: 'reach.subscribers',
          value: 1000,
          unit: null,
          confidence: '0.85',
          extractedBy: 'llm',
          sourceMessageId: null,
          rawSnippet: '1k подписчиков',
          capturedAt: NOW,
          createdAt: NOW,
        },
      ],
      mediaAssets: [
        {
          id: 'a1',
          conversationId: 'c1',
          profileId: 'p1',
          kind: 'media_kit',
          s3Key: 'bloggers/p1/a1',
          mime: 'application/pdf',
          bytes: 2048,
          sha256: 'deadbeef',
          sourceTgMsgId: '42',
          createdAt: NOW,
        },
      ],
    });

    const out = await bloggerProfilesService.get('p1');

    // confidence is a real number, not a Decimal/string.
    expect(typeof out.dataPoints[0]?.confidence).toBe('number');
    expect(out.dataPoints[0]?.confidence).toBe(0.85);

    // mediaAssets carry safe metadata only.
    expect(out.mediaAssets).toEqual([
      { id: 'a1', kind: 'media_kit', mime: 'application/pdf', bytes: 2048, createdAt: NOW },
    ]);
    // No credential / object-store key leaks.
    expect(JSON.stringify(out.mediaAssets)).not.toContain('s3Key');
    expect((out.mediaAssets[0] as Record<string, unknown>).s3Key).toBeUndefined();
  });

  it('throws notFound for a missing profile', async () => {
    prismaMock.bloggerProfile.findUnique.mockResolvedValue(null);
    await expect(bloggerProfilesService.get('nope')).rejects.toMatchObject({ statusCode: 404 });
  });
});
