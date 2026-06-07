import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const prisma = {
    bloggerProfile: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    bloggerPostInsight: {
      upsert: vi.fn(),
    },
  };
  return { prisma };
});

vi.mock('@nosquare/db', () => ({ getPrisma: () => mocks.prisma }));

import {
  markPostInsightRefreshFailedForChannel,
  upsertPostInsightsFromSnapshot,
} from '../services/post-insights.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.bloggerProfile.findUnique.mockResolvedValue({ id: 'profile1' });
  mocks.prisma.bloggerProfile.update.mockResolvedValue({});
  mocks.prisma.bloggerPostInsight.upsert.mockResolvedValue({});
});

describe('post insight upsert service', () => {
  it('upserts Telegram public post metrics with a public post URL', async () => {
    const out = await upsertPostInsightsFromSnapshot({
      channelId: 'ch1',
      snapshot: {
        platform: 'telegram',
        externalId: '100',
        handle: 'creator',
        title: 'Creator',
        description: '',
        links: [],
        posts: [
          {
            id: '42',
            date: '2026-06-01T00:00:00Z',
            text: 'post text',
            urls: [],
            metrics: { views: 1000, forwards: 12, reactions: 20 },
          },
        ],
        raw: {},
      },
    });

    expect(out).toMatchObject({ profileId: 'profile1', upserted: 1 });
    expect(mocks.prisma.bloggerPostInsight.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          profileId_platform_externalPostId: {
            profileId: 'profile1',
            platform: 'telegram',
            externalPostId: '42',
          },
        },
        create: expect.objectContaining({
          url: 'https://t.me/creator/42',
          metrics: { views: 1000, forwards: 12, reactions: 20 },
          source: 'telegram_public_parse',
        }),
      }),
    );
    expect(mocks.prisma.bloggerProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'profile1' },
        data: expect.objectContaining({ postInsightRefreshStatus: 'idle' }),
      }),
    );
  });

  it('stores empty metrics honestly when no reliable metrics are available', async () => {
    await upsertPostInsightsFromSnapshot({
      channelId: 'ch1',
      snapshot: {
        platform: 'youtube',
        externalId: 'yt',
        handle: '@creator',
        title: 'Creator',
        description: '',
        links: [],
        posts: [{ id: 'v1', date: '2026-06-01T00:00:00Z', text: 'video', urls: [] }],
        raw: {},
      },
    });
    const call = mocks.prisma.bloggerPostInsight.upsert.mock.calls[0]![0] as {
      create: { metrics: unknown; metricCapturedAt: Date | null; source: string };
    };
    expect(call.create.metrics).toEqual({});
    expect(call.create.metricCapturedAt).toBeNull();
    expect(call.create.source).toBe('scrapecreators');
  });

  it('marks pending refresh as failed by channel id', async () => {
    await markPostInsightRefreshFailedForChannel('ch1', 'boom');
    expect(mocks.prisma.bloggerProfile.update).toHaveBeenCalledWith({
      where: { channelId: 'ch1' },
      data: {
        postInsightRefreshStatus: 'failed',
        postInsightRefreshError: 'boom',
      },
    });
  });
});
