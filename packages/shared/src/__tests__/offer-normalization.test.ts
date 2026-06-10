import { describe, it, expect } from 'vitest';
import { normalizeOffer, resolveViewsBasis } from '../offer-normalization.js';
import { parsePriceRange } from '../price.js';
import { PlacementOfferDraftZ } from '../schemas/placement-offer.js';

/** price-normalization-v2: pure fx/CPM math, range parsing, schema expansion. */

const USD = { currency: 'USD', rateToRub: 92.4, asOf: '2026-06-01T00:00:00.000Z' };

describe('normalizeOffer', () => {
  it('RUB normalizes with rate 1 and no fx stamp', () => {
    const n = normalizeOffer(
      { kind: 'post', currency: 'RUB', priceMin: 47000, priceMax: 47000 },
      null,
      null,
    );
    expect(n).toMatchObject({ priceRubMin: 47000, priceRubMax: 47000, fxRateUsed: 1, fxAsOf: null });
  });

  it('converts non-RUB via the rate and stamps fx provenance', () => {
    const n = normalizeOffer({ kind: 'post', currency: 'usd', priceMin: 400, priceMax: 400 }, USD, null);
    expect(n.priceRubMin).toBe(36960);
    expect(n.fxRateUsed).toBe(92.4);
    expect(n.fxAsOf?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('missing rate → all-null normalization (never an invented rate)', () => {
    const n = normalizeOffer({ kind: 'post', currency: 'GBP', priceMin: 300, priceMax: 300 }, null, null);
    expect(n.priceRubMin).toBeNull();
    expect(n.cpmRub).toBeNull();
  });

  it('open «от»-range keeps max null through conversion', () => {
    const n = normalizeOffer({ kind: 'post', currency: 'USD', priceMin: 400, priceMax: null }, USD, null);
    expect(n.priceRubMin).toBe(36960);
    expect(n.priceRubMax).toBeNull();
  });

  it('CPM = priceRubMin / views × 1000 with basis provenance', () => {
    const n = normalizeOffer(
      { kind: 'post', currency: 'RUB', priceMin: 47000, priceMax: 47000 },
      null,
      { views: 10000, source: 'post_insights' },
    );
    expect(n.cpmRub).toBe(4700);
    expect(n.viewsBasis).toBe(10000);
    expect(n.viewsSource).toBe('post_insights');
  });

  it('package/other kinds carry no CPM regardless of views', () => {
    const n = normalizeOffer(
      { kind: 'package', currency: 'RUB', priceMin: 50000, priceMax: 50000 },
      null,
      { views: 10000, source: 'post_insights' },
    );
    expect(n.cpmRub).toBeNull();
  });
});

describe('resolveViewsBasis', () => {
  const insight = (platform: string, views: number, at: string) => ({
    platform,
    metrics: { views },
    publishedAt: at,
  });

  it('median of the platform posts (outlier-resistant), not the mean', () => {
    const basis = resolveViewsBasis(
      [
        insight('telegram', 1000, '2026-06-01T00:00:00Z'),
        insight('telegram', 1200, '2026-06-02T00:00:00Z'),
        insight('telegram', 90000, '2026-06-03T00:00:00Z'), // top-post outlier
      ],
      'telegram',
      500,
    );
    expect(basis).toEqual({ views: 1200, source: 'post_insights' });
  });

  it('falls back to profile avgViews when the platform has no usable posts', () => {
    expect(resolveViewsBasis([insight('youtube', 5000, '2026-06-01T00:00:00Z')], 'telegram', 800)).toEqual({
      views: 800,
      source: 'profile_avg',
    });
  });

  it('null when neither basis exists', () => {
    expect(resolveViewsBasis([], null, null)).toBeNull();
  });
});

describe('parsePriceRange', () => {
  it.each([
    ['5-7к', { min: 5000, max: 7000 }],
    ['5—7 тыс', { min: 5000, max: 7000 }],
    ['от 118 000', { min: 118000, max: null }],
    ['до 30к', { min: null, max: 30000 }],
    ['47 000', { min: 47000, max: 47000 }],
    ['1.2млн', { min: 1200000, max: 1200000 }],
  ])('%s', (raw, expected) => {
    expect(parsePriceRange(raw)).toEqual(expected);
  });

  it('non-prices stay null', () => {
    expect(parsePriceRange('договорная')).toBeNull();
  });
});

describe('PlacementOfferDraftZ ranges', () => {
  it('«5-7к» string price expands into bounds, price mirrors min, rawPrice verbatim', () => {
    const d = PlacementOfferDraftZ.parse({ kind: 'post', price: '5-7к' });
    expect(d).toMatchObject({ price: 5000, price_min: 5000, price_max: 7000, rawPrice: '5-7к' });
  });

  it('«от 118 000» stays open-ended, not an exact number', () => {
    const d = PlacementOfferDraftZ.parse({ kind: 'post', price: 'от 118 000' });
    expect(d).toMatchObject({ price: 118000, price_min: 118000, price_max: null });
  });

  it('«до 30к» bounds from above with null min', () => {
    const d = PlacementOfferDraftZ.parse({ kind: 'post', price: 'до 30к' });
    expect(d).toMatchObject({ price_min: null, price_max: 30000 });
    expect(d.price).toBeNull();
  });

  it('explicit disagreeing price/price_min is rejected', () => {
    expect(PlacementOfferDraftZ.safeParse({ kind: 'post', price: 47000, price_min: 40000 }).success).toBe(
      false,
    );
  });

  it('inverted bounds are rejected', () => {
    expect(
      PlacementOfferDraftZ.safeParse({ kind: 'post', price_min: 7000, price_max: 5000 }).success,
    ).toBe(false);
  });
});
