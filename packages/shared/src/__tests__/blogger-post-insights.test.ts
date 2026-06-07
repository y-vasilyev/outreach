import { describe, expect, it } from 'vitest';
import {
  buildFitBreakdown,
  computePostMetricFreshness,
  rankPostInsightsForPreview,
  scorePostPerformance,
  type BloggerPostInsight,
  type BloggerProfile,
} from '../index.js';

const NOW = new Date('2026-06-07T00:00:00Z');

function post(over: Partial<BloggerPostInsight> = {}): BloggerPostInsight {
  return {
    id: 'post1',
    profileId: 'p1',
    channelId: 'ch1',
    platform: 'telegram',
    externalPostId: '42',
    url: 'https://t.me/test/42',
    publishedAt: '2026-06-01T00:00:00Z',
    textSnippet: 'финтех продукт для founders',
    mediaKind: 'post',
    metrics: { views: 20_000, reactions: 200 },
    metricCapturedAt: '2026-06-06T00:00:00Z',
    source: 'telegram_public_parse',
    freshness: { state: 'fresh', ageDays: 1 },
    performanceScore: 0,
    createdAt: '2026-06-06T00:00:00Z',
    updatedAt: '2026-06-06T00:00:00Z',
    ...over,
  };
}

describe('post insight freshness and scoring', () => {
  it('marks fresh, stale, unavailable, and pending states explicitly', () => {
    expect(
      computePostMetricFreshness({ metrics: { views: 1 }, metricCapturedAt: '2026-06-06T00:00:00Z' }, NOW),
    ).toEqual({ state: 'fresh', ageDays: 1 });
    expect(
      computePostMetricFreshness({ metrics: { views: 1 }, metricCapturedAt: '2026-04-01T00:00:00Z' }, NOW),
    ).toEqual({ state: 'stale', ageDays: 67 });
    expect(computePostMetricFreshness({ metrics: {}, metricCapturedAt: null }, NOW)).toEqual({
      state: 'unavailable',
      ageDays: null,
    });
    expect(
      computePostMetricFreshness({ metrics: {}, metricCapturedAt: null, refreshStatus: 'pending' }, NOW),
    ).toEqual({ state: 'pending', ageDays: null });
  });

  it('scores top posts without inventing missing metrics', () => {
    const high = scorePostPerformance(post(), { avgViews: 10_000, now: NOW });
    const missing = scorePostPerformance(post({ metrics: {}, metricCapturedAt: null }), {
      avgViews: 10_000,
      now: NOW,
    });
    expect(high).toBeGreaterThan(0.5);
    expect(missing).toBe(0);
  });

  it('orders previews by deterministic performance score', () => {
    const previews = rankPostInsightsForPreview(
      [
        post({ id: 'low', metrics: { views: 100 }, externalPostId: '1' }),
        post({ id: 'high', metrics: { views: 30_000, reactions: 400 }, externalPostId: '2' }),
      ],
      { avgViews: 10_000, now: NOW, limit: 1 },
    );
    expect(previews).toHaveLength(1);
    expect(previews[0]!.id).toBe('high');
  });
});

describe('catalog fit signal assembly', () => {
  it('builds positive signals, gaps, and post evidence ids from real inputs', () => {
    const profile = {
      topics: ['финтех', 'стартапы'],
      formats: ['telegram_post'],
      rateCards: [{ format: 'telegram_post', price: 10_000, currency: 'RUB' }],
      reach: 100_000,
      avgViews: 15_000,
    } as Pick<BloggerProfile, 'topics' | 'formats' | 'rateCards' | 'reach' | 'avgViews'>;
    const fit = buildFitBreakdown(
      {
        topic: 'финтех',
        audienceTarget: 'founders',
        formats: ['telegram_post'],
        geo: [],
        notes: 'founders',
      },
      profile,
      { score: 0.82, rationale: 'topic and format fit' },
      [post({ id: 'evidence' })],
    );

    expect(fit.positiveSignals).toContain('topic match: финтех');
    expect(fit.gaps).not.toContain('rate card is missing');
    expect(fit.evidencePostIds).toEqual(['evidence']);
    expect(fit.scoreBreakdown.total).toBe(0.82);
  });
});
