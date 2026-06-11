import { describe, expect, it } from 'vitest';

import {
  buildChannelSummary,
  computeBloggerEngagement,
  normalizeEngagementRate,
} from '../blogger-profile-enrichment.js';

describe('buildChannelSummary', () => {
  it('returns platform/handle/title and the public profile url, never id/links', () => {
    const summary = buildChannelSummary({
      platform: 'telegram',
      handle: '@gedonizm',
      title: 'Отчаянный гедонизм',
      links: ['https://t.me/gedonizm'],
    });
    expect(summary).toEqual({
      platform: 'telegram',
      handle: 'gedonizm',
      title: 'Отчаянный гедонизм',
      url: 'https://t.me/gedonizm',
    });
    expect(Object.keys(summary!)).not.toContain('id');
    expect(Object.keys(summary!)).not.toContain('links');
  });

  it('builds platform-specific urls', () => {
    expect(buildChannelSummary({ platform: 'instagram', handle: 'kate' })?.url).toBe(
      'https://instagram.com/kate',
    );
    expect(buildChannelSummary({ platform: 'youtube', handle: 'kate' })?.url).toBe(
      'https://youtube.com/@kate',
    );
    // No deterministic public profile url for this platform — url stays null.
    expect(buildChannelSummary({ platform: 'vk', handle: 'kate' })?.url).toBeNull();
  });

  it('returns null without a channel, platform or handle', () => {
    expect(buildChannelSummary(null)).toBeNull();
    expect(buildChannelSummary({ platform: 'telegram', handle: '' })).toBeNull();
    expect(buildChannelSummary({ platform: null, handle: 'kate' })).toBeNull();
  });

  it('normalizes empty title to null', () => {
    expect(buildChannelSummary({ platform: 'telegram', handle: 'kate', title: '  ' })?.title).toBeNull();
  });
});

describe('normalizeEngagementRate', () => {
  it('keeps fractions and converts percents', () => {
    expect(normalizeEngagementRate(0.042)).toBe(0.042);
    expect(normalizeEngagementRate(1)).toBe(1);
    expect(normalizeEngagementRate(4.2)).toBeCloseTo(0.042);
  });
});

describe('computeBloggerEngagement', () => {
  it('uses the linked channel platform as the ERR basis when its audience is known', () => {
    const engagement = computeBloggerEngagement({
      avgViews: 4200,
      channelPlatform: 'telegram',
      platformAudience: [
        { platform: 'youtube', subscribers: 500_000 },
        { platform: 'telegram', subscribers: 100_000 },
      ],
    });
    expect(engagement.err).toBe(0.042);
    expect(engagement.errPlatform).toBe('telegram');
    expect(engagement.subscribersBasis).toBe(100_000);
  });

  it('falls back to the largest audience when the channel platform is unknown', () => {
    const engagement = computeBloggerEngagement({
      avgViews: 5000,
      channelPlatform: null,
      platformAudience: [
        { platform: 'telegram', subscribers: 100_000 },
        { platform: 'youtube', subscribers: 500_000 },
      ],
    });
    expect(engagement.errPlatform).toBe('youtube');
    expect(engagement.err).toBe(0.01);
  });

  it('returns null ERR without audience or avgViews', () => {
    expect(
      computeBloggerEngagement({ avgViews: 5000, platformAudience: [] }).err,
    ).toBeNull();
    expect(
      computeBloggerEngagement({
        avgViews: null,
        platformAudience: [{ platform: 'telegram', subscribers: 100 }],
      }).err,
    ).toBeNull();
    expect(
      computeBloggerEngagement({
        avgViews: 5000,
        platformAudience: [{ platform: 'telegram', subscribers: 0 }],
      }).err,
    ).toBeNull();
  });

  it('averages stated post ER with percent/fraction normalization', () => {
    const engagement = computeBloggerEngagement({
      avgViews: null,
      platformAudience: [],
      postInsights: [
        { platform: 'instagram', metrics: { engagementRate: 4 } }, // percent
        { platform: 'instagram', metrics: { engagementRate: 0.02 } }, // fraction
      ],
    });
    expect(engagement.avgPostEr).toBeCloseTo(0.03);
    expect(engagement.postsBasis).toBe(2);
  });

  it('derives post ER from interaction counts when no rate is stated', () => {
    const engagement = computeBloggerEngagement({
      avgViews: null,
      platformAudience: [],
      postInsights: [
        { platform: 'telegram', metrics: { views: 1000, reactions: 30, forwards: 10 } },
        // No views — cannot derive, must not count toward the basis.
        { platform: 'telegram', metrics: { reactions: 5 } },
      ],
    });
    expect(engagement.avgPostEr).toBe(0.04);
    expect(engagement.postsBasis).toBe(1);
  });

  it('groups post aggregates per platform for a multi-platform blogger', () => {
    const engagement = computeBloggerEngagement({
      avgViews: 4200,
      channelPlatform: 'telegram',
      platformAudience: [{ platform: 'telegram', subscribers: 100_000 }],
      postInsights: [
        { platform: 'telegram', metrics: { views: 4000, reactions: 80 } },
        { platform: 'telegram', metrics: { views: 4400, reactions: 96 } },
        { platform: 'youtube', metrics: { views: 100_000, likes: 1000 } },
        { platform: 'youtube', metrics: {} }, // no usable metrics → ignored
      ],
    });
    expect(engagement.perPlatform).toEqual([
      { platform: 'telegram', avgPostEr: 0.0209, avgViews: 4200, postsBasis: 2 },
      { platform: 'youtube', avgPostEr: 0.01, avgViews: 100_000, postsBasis: 1 },
    ]);
  });
});
