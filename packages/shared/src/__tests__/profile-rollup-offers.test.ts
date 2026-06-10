import { describe, expect, it } from 'vitest';

import { rollUpProfileFields, type RollupDataPoint } from '../profile-rollup.js';
import type { PlacementOffer } from '../schemas/placement-offer.js';

/**
 * Roll-up of structured placement offers (entity-style-rate-cards, task 3.1).
 * The worker (Section 2) persists offers as `placement.offer` data points whose
 * `value` is a `PlacementOffer`. The roll-up collects/dedupes them, sets
 * `placementOffers`, and derives compatibility `rateCards`/`formats` that win
 * over legacy `rate.<format>` cards for the same derived format key.
 */

const at = (iso: string) => iso;

function offer(partial: Partial<PlacementOffer>): PlacementOffer {
  return {
    kind: 'post',
    platform: 'telegram',
    price: null,
    currency: 'RUB',
    attributes: [],
    confidence: 0.8,
    rawSnippet: '',
    rawPrice: '',
    sourceMessageId: null,
    extractedBy: 'llm',
    capturedAt: at('2026-05-01T00:00:00Z'),
    ...partial,
  };
}

function offerPoint(value: PlacementOffer, capturedAt = value.capturedAt ?? at('2026-05-01T00:00:00Z')): RollupDataPoint {
  return {
    field: 'placement.offer',
    value,
    confidence: value.confidence,
    capturedAt: capturedAt as string,
  };
}

describe('rollUpProfileFields — placement offers', () => {
  it('keeps day vs month post offers as two distinct offers and rate cards', () => {
    const dayPost = offer({
      price: 13000,
      rawSnippet: 'пост на сутки 13000',
      attributes: [{ key: 'duration', value: 'day', confidence: 0.9, rawSnippet: 'на сутки' }],
    });
    const monthPost = offer({
      price: 21000,
      rawSnippet: 'пост на месяц 21000',
      attributes: [{ key: 'duration', value: 'month', confidence: 0.9, rawSnippet: 'на месяц' }],
    });
    const out = rollUpProfileFields([offerPoint(dayPost), offerPoint(monthPost)]);

    expect(out.placementOffers).toHaveLength(2);
    expect(out.rateCards).toEqual([
      { format: 'telegram_post_day', price: 13000, currency: 'RUB' },
      { format: 'telegram_post_month', price: 21000, currency: 'RUB' },
    ]);
    expect(out.formats).toEqual(['telegram_post_day', 'telegram_post_month']);
  });

  it('structured offer wins over a legacy rate.<format> for the same derived key', () => {
    const monthPost = offer({
      price: 21000,
      attributes: [{ key: 'duration', value: 'month', confidence: 0.9, rawSnippet: '' }],
    });
    const points: RollupDataPoint[] = [
      offerPoint(monthPost),
      // Legacy generic card mapping to telegram_post_month is superseded.
      { field: 'rate.telegram_post_month', value: 99999, unit: 'RUB', confidence: 0.95, capturedAt: at('2026-05-02T00:00:00Z') },
    ];
    const out = rollUpProfileFields(points);
    const monthCards = out.rateCards.filter((c) => c.format === 'telegram_post_month');
    expect(monthCards).toEqual([{ format: 'telegram_post_month', price: 21000, currency: 'RUB' }]);
  });

  it('preserves distinct legacy cards that have no structured equivalent', () => {
    const monthPost = offer({
      price: 21000,
      attributes: [{ key: 'duration', value: 'month', confidence: 0.9, rawSnippet: '' }],
    });
    const points: RollupDataPoint[] = [
      offerPoint(monthPost),
      { field: 'rate.youtube_shorts', value: 42000, unit: 'RUB', confidence: 0.9, capturedAt: at('2026-05-01T00:00:00Z') },
    ];
    const out = rollUpProfileFields(points);
    expect(out.rateCards).toEqual([
      { format: 'telegram_post_month', price: 21000, currency: 'RUB' },
      { format: 'youtube_shorts', price: 42000, currency: 'RUB' },
    ]);
  });

  it('dedupes identical offers re-quoted across messages, keeping highest confidence', () => {
    const lowConf = offer({ price: 30000, kind: 'offsite_review', platform: null, confidence: 0.5, rawSnippet: 'обзор 30000', capturedAt: at('2026-05-01T00:00:00Z') });
    const highConf = offer({ price: 30000, kind: 'offsite_review', platform: null, confidence: 0.95, rawSnippet: 'обзор 30000', capturedAt: at('2026-04-01T00:00:00Z') });
    const out = rollUpProfileFields([offerPoint(lowConf), offerPoint(highConf)]);
    expect(out.placementOffers).toHaveLength(1);
    expect(out.placementOffers[0]?.confidence).toBe(0.95);
    expect(out.rateCards).toEqual([{ format: 'offsite_review', price: 30000, currency: 'RUB' }]);
  });

  it('skips invalid placement.offer values without throwing', () => {
    const valid = offer({ price: 13000, attributes: [{ key: 'duration', value: 'day', confidence: 1, rawSnippet: '' }] });
    const points: RollupDataPoint[] = [
      { field: 'placement.offer', value: { not: 'an offer' }, confidence: 0.9, capturedAt: at('2026-05-01T00:00:00Z') },
      offerPoint(valid),
    ];
    const out = rollUpProfileFields(points);
    expect(out.placementOffers).toHaveLength(1);
  });

  it('keeps a term-only (price-less) offer as an offered format with no rate card', () => {
    const termOnly = offer({
      kind: 'integration',
      price: null,
      platform: 'youtube',
      attributes: [{ key: 'notes', value: 'обсуждается', confidence: 0.6, rawSnippet: '' }],
    });
    const out = rollUpProfileFields([offerPoint(termOnly)]);
    expect(out.placementOffers).toHaveLength(1);
    expect(out.rateCards).toEqual([]); // no price → no compatibility card
    expect(out.formats).toEqual(['youtube_integration']);
  });

  it('behaves identically when there are no placement.offer points', () => {
    const points: RollupDataPoint[] = [
      { field: 'rate.post', value: 15000, unit: 'RUB', confidence: 0.9, capturedAt: at('2026-05-01T00:00:00Z') },
    ];
    const out = rollUpProfileFields(points);
    expect(out.placementOffers).toEqual([]);
    expect(out.rateCards).toEqual([{ format: 'post', price: 15000, currency: 'RUB' }]);
    expect(out.formats).toEqual(['post']);
  });
});
