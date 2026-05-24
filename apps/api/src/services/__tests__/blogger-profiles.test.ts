// Env stubbing runs from vitest's setupFiles in apps/api/vitest.config.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  // Pin the clock so age-in-days assertions don't drift with the real wall clock.
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
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

  it('returns per-section freshness derived from the data points', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const profileCapturedAt = new Date(NOW.getTime() - 10 * DAY);
    const rateOld = new Date(NOW.getTime() - 120 * DAY); // > 90d → stale
    const audienceFresh = new Date(NOW.getTime() - 30 * DAY); // < 180d → fresh
    prismaMock.bloggerProfile.findUnique.mockResolvedValue({
      id: 'p2',
      channelId: 'chan_2',
      topics: ['food'],
      languages: ['ru'],
      formats: ['post'],
      audience: {},
      rateCards: [],
      reach: null,
      avgViews: null,
      capturedAt: profileCapturedAt,
      createdAt: profileCapturedAt,
      updatedAt: profileCapturedAt,
      dataPoints: [
        {
          id: 'dp_rate',
          profileId: 'p2',
          field: 'rate.post',
          value: 5000,
          unit: 'RUB',
          confidence: '0.9',
          extractedBy: 'llm',
          sourceMessageId: null,
          rawSnippet: '',
          capturedAt: rateOld,
          createdAt: rateOld,
        },
        {
          id: 'dp_aud',
          profileId: 'p2',
          field: 'audience.geo',
          value: { RU: 0.9 },
          unit: null,
          confidence: '0.7',
          extractedBy: 'llm',
          sourceMessageId: null,
          rawSnippet: '',
          capturedAt: audienceFresh,
          createdAt: audienceFresh,
        },
      ],
      mediaAssets: [],
    });

    const out = await bloggerProfilesService.get('p2');
    expect(out.freshness.rateCards.stale).toBe(true);
    expect(out.freshness.rateCards.ageDays).toBe(120);
    expect(out.freshness.audience).toEqual({ stale: false, ageDays: 30 });
    // topics has no contributing data point → stale-by-default, no fallback
    // to profile.capturedAt (would otherwise be fresh-by-accident).
    expect(out.freshness.topics).toEqual({ stale: true, ageDays: null });
  });
});
