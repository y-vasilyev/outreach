import { describe, expect, it } from 'vitest';

import { rollUpProfileFields, type RollupDataPoint } from '@nosquare/shared';

/**
 * Deterministic profile roll-up (agency-sourcing-matching M5, task 5.3/5.5):
 * composes standardized BloggerProfile fields from ProfileDataPoint rows using
 * latest-high-confidence-per-field. Pure function — lives in @nosquare/shared.
 */
describe('rollUpProfileFields', () => {
  const at = (iso: string) => iso;

  it('returns empty/null fields for no data points', () => {
    const out = rollUpProfileFields([]);
    expect(out.rateCards).toEqual([]);
    expect(out.reach).toBeNull();
    expect(out.avgViews).toBeNull();
    expect(out.capturedAt).toBeNull();
    expect(out.topics).toEqual([]);
  });

  it('composes rate cards per format from numeric values', () => {
    const points: RollupDataPoint[] = [
      { field: 'rate.post', value: 15000, unit: 'RUB', confidence: 0.9, capturedAt: at('2026-05-01T00:00:00Z') },
      { field: 'rate.story', value: 8000, unit: 'RUB', confidence: 0.9, capturedAt: at('2026-05-01T00:00:00Z') },
    ];
    const out = rollUpProfileFields(points);
    expect(out.rateCards).toEqual([
      { format: 'post', price: 15000, currency: 'RUB' },
      { format: 'story', price: 8000, currency: 'RUB' },
    ]);
    expect(out.formats.sort()).toEqual(['post', 'story']);
  });

  it('picks the highest-confidence value for a field', () => {
    const points: RollupDataPoint[] = [
      { field: 'rate.post', value: 10000, confidence: 0.5, capturedAt: at('2026-05-10T00:00:00Z') },
      { field: 'rate.post', value: 15000, confidence: 0.9, capturedAt: at('2026-05-01T00:00:00Z') },
    ];
    const out = rollUpProfileFields(points);
    // 0.9 beats 0.5 even though it's older — confidence dominates.
    expect(out.rateCards).toEqual([{ format: 'post', price: 15000, currency: 'RUB' }]);
  });

  it('breaks confidence ties by recency (latest wins)', () => {
    const points: RollupDataPoint[] = [
      { field: 'reach', value: 9000, confidence: 0.8, capturedAt: at('2026-05-01T00:00:00Z') },
      { field: 'reach', value: 12000, confidence: 0.8, capturedAt: at('2026-05-15T00:00:00Z') },
    ];
    const out = rollUpProfileFields(points);
    expect(out.reach).toBe(12000);
  });

  it('prefers the fresher value within a confidence band (S2)', () => {
    // Stale 0.9 vs fresh 0.8 — within the 0.15 band, so recency wins.
    const points: RollupDataPoint[] = [
      { field: 'rate.post', value: 15000, confidence: 0.9, capturedAt: at('2026-01-01T00:00:00Z') },
      { field: 'rate.post', value: 12000, confidence: 0.8, capturedAt: at('2026-05-01T00:00:00Z') },
    ];
    const out = rollUpProfileFields(points);
    expect(out.rateCards).toEqual([{ format: 'post', price: 12000, currency: 'RUB' }]);
  });

  it('keeps higher confidence when the gap exceeds the band even if older', () => {
    // 0.9 vs 0.6 — gap 0.3 > 0.15, so confidence dominates despite being older.
    const points: RollupDataPoint[] = [
      { field: 'rate.post', value: 15000, confidence: 0.9, capturedAt: at('2026-01-01T00:00:00Z') },
      { field: 'rate.post', value: 12000, confidence: 0.6, capturedAt: at('2026-05-01T00:00:00Z') },
    ];
    const out = rollUpProfileFields(points);
    expect(out.rateCards).toEqual([{ format: 'post', price: 15000, currency: 'RUB' }]);
  });

  it('parses numeric strings and rounds reach/avgViews', () => {
    const points: RollupDataPoint[] = [
      { field: 'reach.story', value: '12 000', confidence: 0.8, capturedAt: at('2026-05-01T00:00:00Z') },
      { field: 'views.avg', value: 3450.7, confidence: 0.7, capturedAt: at('2026-05-01T00:00:00Z') },
    ];
    const out = rollUpProfileFields(points);
    expect(out.reach).toBe(12000);
    expect(out.avgViews).toBe(3451);
  });

  it('composes audience distributions from record values', () => {
    const points: RollupDataPoint[] = [
      { field: 'audience.geo', value: { Россия: 0.7, Казахстан: 0.1 }, confidence: 0.6, capturedAt: at('2026-05-01T00:00:00Z') },
      { field: 'audience.age', value: { '25-34': 0.5 }, confidence: 0.5, capturedAt: at('2026-05-01T00:00:00Z') },
    ];
    const out = rollUpProfileFields(points);
    expect(out.audience.geo).toEqual({ Россия: 0.7, Казахстан: 0.1 });
    expect(out.audience.age).toEqual({ '25-34': 0.5 });
    expect(out.audience.gender).toBeUndefined();
  });

  it('unions topics/languages across points (deduped)', () => {
    const points: RollupDataPoint[] = [
      { field: 'topics', value: ['финансы', 'инвестиции'], confidence: 0.7, capturedAt: at('2026-05-01T00:00:00Z') },
      { field: 'topic', value: 'финансы', confidence: 0.6, capturedAt: at('2026-05-02T00:00:00Z') },
      { field: 'language', value: 'ru', confidence: 0.9, capturedAt: at('2026-05-01T00:00:00Z') },
    ];
    const out = rollUpProfileFields(points);
    expect(out.topics).toEqual(['финансы', 'инвестиции']);
    expect(out.languages).toEqual(['ru']);
  });

  it('sets capturedAt to the most recent contributing data point', () => {
    const points: RollupDataPoint[] = [
      { field: 'rate.post', value: 1000, confidence: 0.9, capturedAt: at('2026-05-01T00:00:00Z') },
      { field: 'reach', value: 5000, confidence: 0.9, capturedAt: at('2026-05-20T12:00:00Z') },
    ];
    const out = rollUpProfileFields(points);
    expect(out.capturedAt).toBe('2026-05-20T12:00:00.000Z');
  });

  it('skips rate fields with non-numeric values', () => {
    const points: RollupDataPoint[] = [
      { field: 'rate.post', value: 'договорная', confidence: 0.4, capturedAt: at('2026-05-01T00:00:00Z') },
    ];
    const out = rollUpProfileFields(points);
    expect(out.rateCards).toEqual([]);
  });
});
