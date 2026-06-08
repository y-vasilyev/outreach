import { describe, it, expect } from 'vitest';
import { rollUpProfileFields, PLACEMENT_OFFER_CONFIDENCE_FLOOR, type RollupDataPoint } from '../profile-rollup.js';
import { getOfferAttributes, getOfferAttribute } from '../placement-offers.js';
import type { PlacementOffer } from '../schemas/placement-offer.js';

function offerPoint(confidence: number, price: number, extra: Partial<PlacementOffer> = {}): RollupDataPoint {
  const offer: PlacementOffer = {
    kind: 'post',
    platform: 'telegram',
    price,
    currency: 'RUB',
    attributes: [{ key: 'duration', value: 'day', confidence: 1, rawSnippet: '' }],
    confidence,
    rawSnippet: `post ${price}`,
    sourceMessageId: 'm1',
    extractedBy: 'rate_card_extractor',
    capturedAt: '2026-06-01T00:00:00.000Z',
    ...extra,
  };
  return { field: 'placement.offer', value: offer, confidence, capturedAt: offer.capturedAt! };
}

describe('confidence-floor roll-up (harden-reply-extraction D4)', () => {
  it('excludes a sub-floor offer from the comparable placementOffers view', () => {
    const rolled = rollUpProfileFields([
      offerPoint(0.9, 50000, { rawSnippet: 'good' }),
      offerPoint(0.1, 99999, { rawSnippet: 'garbled' }),
    ]);
    const prices = rolled.placementOffers.map((o) => o.price);
    expect(prices).toContain(50000);
    expect(prices).not.toContain(99999); // sub-floor excluded
  });

  it('sub-floor fact does not leak into derived legacy rateCards/formats', () => {
    // A sub-floor legacy rate.* point must also be suppressed from the
    // comparable rate-card view (codex Blocker 2).
    const rolled = rollUpProfileFields([
      { field: 'rate.story', value: 8000, confidence: 0.1, capturedAt: '2026-06-01T00:00:00.000Z' },
    ]);
    expect(rolled.rateCards.find((c) => c.format === 'story')).toBeUndefined();
    expect(rolled.formats).not.toContain('story');
  });

  it('keeps an above-floor legacy rate card', () => {
    const rolled = rollUpProfileFields([
      { field: 'rate.story', value: 8000, confidence: 0.9, capturedAt: '2026-06-01T00:00:00.000Z' },
    ]);
    expect(rolled.rateCards.find((c) => c.format === 'story')?.price).toBe(8000);
  });

  it('the floor constant is the documented default', () => {
    expect(PLACEMENT_OFFER_CONFIDENCE_FLOOR).toBe(0.2);
  });
});

describe('getOfferAttributes multi-value accessor (harden-reply-extraction)', () => {
  const offer = {
    kind: 'post',
    platform: 'telegram',
    price: 50000,
    currency: 'RUB',
    attributes: [
      { key: 'tax', value: 'налог 8% ИП', confidence: 1, rawSnippet: '' },
      { key: 'tax', value: 'налог на рекламу 3%', confidence: 1, rawSnippet: '' },
      { key: 'duration', value: 'day', confidence: 1, rawSnippet: '' },
    ],
  };

  it('returns ALL values for a repeatable key', () => {
    expect(getOfferAttributes(offer, 'tax')).toEqual(['налог 8% ИП', 'налог на рекламу 3%']);
  });

  it('getOfferAttribute still returns only the first (single-valued path)', () => {
    expect(getOfferAttribute(offer, 'tax')).toBe('налог 8% ИП');
  });

  it('promoted fields yield a one-element array', () => {
    expect(getOfferAttributes(offer, 'platform')).toEqual(['telegram']);
    expect(getOfferAttributes(offer, 'price')).toEqual([50000]);
  });
});
