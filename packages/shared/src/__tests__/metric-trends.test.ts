import { describe, expect, it } from 'vitest';

import { buildMetricTrends, metricForDataPointField } from '../metric-trends.js';
import type { OfferHistoryEntry } from '../placement-offer-rows.js';

const NOW = '2026-06-11T00:00:00.000Z';

function days(n: number): string {
  return new Date(Date.parse(NOW) - n * 24 * 60 * 60 * 1000).toISOString();
}

describe('metricForDataPointField', () => {
  it('mirrors the rollup field mapping', () => {
    expect(metricForDataPointField('reach')).toBe('reach');
    expect(metricForDataPointField('reach.story')).toBe('reach');
    expect(metricForDataPointField('views.avg')).toBe('avgViews');
    expect(metricForDataPointField('avg_views')).toBe('avgViews');
    expect(metricForDataPointField('audience.subscribers.telegram')).toBe('subscribers:telegram');
    expect(metricForDataPointField('rate.post')).toBeNull();
    expect(metricForDataPointField('audience.geo')).toBeNull();
  });
});

describe('buildMetricTrends', () => {
  it('builds per-metric series with prev/30d deltas', () => {
    const { metrics } = buildMetricTrends({
      now: NOW,
      snapshots: [
        { metric: 'subscribers:telegram', value: 100_000, capturedAt: days(60) },
        { metric: 'subscribers:telegram', value: 110_000, capturedAt: days(31) },
        { metric: 'subscribers:telegram', value: 121_000, capturedAt: days(1) },
      ],
    });
    expect(metrics).toHaveLength(1);
    const t = metrics[0]!;
    expect(t.metric).toBe('subscribers:telegram');
    expect(t.points.map((p) => p.value)).toEqual([100_000, 110_000, 121_000]);
    expect(t.deltaPrev).toBe(0.1); // 110k → 121k
    expect(t.delta30d).toBe(0.1); // base = newest point ≥30d old (110k @ 31d)
  });

  it('dedupes consecutive equal values and sorts by time', () => {
    const { metrics } = buildMetricTrends({
      now: NOW,
      snapshots: [
        { metric: 'avgViews', value: 4200, capturedAt: days(1) },
        { metric: 'avgViews', value: 4000, capturedAt: days(10) },
        { metric: 'avgViews', value: 4000, capturedAt: days(5) },
      ],
    });
    expect(metrics[0]!.points.map((p) => p.value)).toEqual([4000, 4200]);
  });

  it('collapses same-day backfill facts into one point (no fake intra-run delta)', () => {
    // One extraction run emitted two facts rolling into `reach` — that is ONE
    // observation, not a trend (codex review).
    const { metrics } = buildMetricTrends({
      now: NOW,
      snapshots: [],
      dataPoints: [
        { field: 'reach.post', value: 5000, capturedAt: `${days(40).slice(0, 10)}T10:00:00.000Z` },
        { field: 'reach.story', value: 12_000, capturedAt: `${days(40).slice(0, 10)}T10:00:01.000Z` },
      ],
    });
    expect(metrics[0]!.points).toHaveLength(1);
    expect(metrics[0]!.points[0]!.value).toBe(12_000); // latest of the day
    expect(metrics[0]!.deltaPrev).toBeNull();
  });

  it('keeps the offer price series in one currency (requote in another currency is not a delta)', () => {
    const entry: OfferHistoryEntry = {
      identityKey: 'telegram|post|day|||',
      platform: 'telegram',
      kind: 'post',
      duration: 'day',
      tariffName: null,
      slot: null,
      active: {
        id: 'r2', status: 'active', priceMin: 13_000, priceMax: null, currency: 'RUB',
        confidence: 0.9, rawPrice: '13000', rawSnippet: '', sourceMessageId: null,
        supersededById: null, capturedAt: days(1),
      },
      history: [
        {
          id: 'r1', status: 'superseded', priceMin: 150, priceMax: null, currency: 'USD',
          confidence: 0.9, rawPrice: '$150', rawSnippet: '', sourceMessageId: null,
          supersededById: 'r2', capturedAt: days(30),
        },
      ],
    };
    const { offers } = buildMetricTrends({ now: NOW, snapshots: [], offerHistory: [entry] });
    // Single RUB observation → no dynamics, NOT a +8567% delta.
    expect(offers).toHaveLength(0);
  });

  it('backfills from superseded data points only before the snapshot era', () => {
    const { metrics } = buildMetricTrends({
      now: NOW,
      snapshots: [{ metric: 'reach', value: 12_000, capturedAt: days(10) }],
      dataPoints: [
        { field: 'reach.story', value: 9000, capturedAt: days(40) }, // backfill
        { field: 'reach', value: '11 000', capturedAt: days(20) }, // backfill, string coercion
        { field: 'reach', value: 99_999, capturedAt: days(5) }, // snapshot era → ignored
        { field: 'rate.post', value: 15_000, capturedAt: days(50) }, // not a metric
      ],
    });
    expect(metrics[0]!.points.map((p) => p.value)).toEqual([9000, 11_000, 12_000]);
  });

  it('returns null deltas for short or zero-based series', () => {
    const single = buildMetricTrends({
      now: NOW,
      snapshots: [{ metric: 'reach', value: 100, capturedAt: days(1) }],
    });
    expect(single.metrics[0]).toMatchObject({ deltaPrev: null, delta30d: null });

    const zeroBase = buildMetricTrends({
      now: NOW,
      snapshots: [
        { metric: 'reach', value: 0, capturedAt: days(2) },
        { metric: 'reach', value: 100, capturedAt: days(1) },
      ],
    });
    expect(zeroBase.metrics[0]!.deltaPrev).toBeNull();
  });

  it('derives per-identity price trends from offer history, skipping low_confidence', () => {
    const history: OfferHistoryEntry[] = [
      {
        identityKey: 'telegram|post|day||',
        platform: 'telegram',
        kind: 'post',
        duration: 'day',
        tariffName: null,
        slot: null,
        active: {
          id: 'r3', status: 'active', priceMin: 15_000, priceMax: null, currency: 'RUB',
          confidence: 0.9, rawPrice: '15000', rawSnippet: '', sourceMessageId: null,
          supersededById: null, capturedAt: days(1),
        },
        history: [
          {
            id: 'r1', status: 'superseded', priceMin: 13_000, priceMax: null, currency: 'RUB',
            confidence: 0.9, rawPrice: '13000', rawSnippet: '', sourceMessageId: null,
            supersededById: 'r3', capturedAt: days(40),
          },
          {
            id: 'r2', status: 'low_confidence', priceMin: 1, priceMax: null, currency: 'RUB',
            confidence: 0.2, rawPrice: '1', rawSnippet: '', sourceMessageId: null,
            supersededById: null, capturedAt: days(20),
          },
        ],
      },
      {
        identityKey: 'youtube|integration|||',
        platform: 'youtube',
        kind: 'integration',
        duration: null,
        tariffName: null,
        slot: null,
        active: {
          id: 'r4', status: 'active', priceMin: 40_000, priceMax: null, currency: 'RUB',
          confidence: 0.9, rawPrice: '40000', rawSnippet: '', sourceMessageId: null,
          supersededById: null, capturedAt: days(2),
        },
        history: [], // single observation → no dynamics
      },
    ];
    const { offers } = buildMetricTrends({ now: NOW, snapshots: [], offerHistory: history });
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      identityKey: 'telegram|post|day||',
      currency: 'RUB',
      deltaPrev: expect.closeTo(0.1538, 3), // 13k → 15k
    });
    expect(offers[0]!.points.map((p) => p.value)).toEqual([13_000, 15_000]);
  });
});
