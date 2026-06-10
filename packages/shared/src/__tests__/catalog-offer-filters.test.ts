import { describe, it, expect } from 'vitest';
import {
  CatalogOfferFiltersZ,
  isOfferStale,
  labelOfferStaleness,
  offerMatchesFilters,
  precutIncludesProfile,
  profileMatchesOfferFilters,
} from '../catalog-offer-filters.js';
import { isShortlisted, type MatchableProfile } from '../matching.js';
import type { AdBrief } from '../schemas/matching.js';
import { composeOffersFromRows, type PlacementOfferRowLike } from '../placement-offer-rows.js';

/**
 * catalog-sql-search: the PURE filter semantics (source of truth for the SQL
 * compilation in apps/api) + the matching pre-cut superset guarantee.
 */

const NOW = new Date('2026-06-10T00:00:00Z');

function row(over: Partial<PlacementOfferRowLike> = {}): PlacementOfferRowLike {
  return {
    id: over.id ?? 'r1',
    platform: 'telegram',
    kind: 'post',
    priceMin: 47000,
    priceMax: 47000,
    currency: 'RUB',
    identityKey: 'telegram|post||||',
    status: 'active',
    confidence: 0.9,
    attributes: [],
    rawPrice: '',
    rawSnippet: 'пост 47 000',
    sourceMessageId: 'm1',
    extractedBy: 'rate_card_extractor',
    capturedAt: '2026-06-01T00:00:00.000Z',
    createdAt: '2026-06-01T00:00:00.000Z',
    ...over,
  };
}

const filters = (over: Record<string, unknown> = {}) => CatalogOfferFiltersZ.parse(over);

describe('offerMatchesFilters / profileMatchesOfferFilters', () => {
  it('the operator core query: platform+kind+price+freshness on ONE offer', () => {
    const f = filters({ platform: 'telegram', kind: 'post', priceRubMax: 50000, offerFreshDays: 60 });
    expect(offerMatchesFilters(row(), f, NOW)).toBe(true);
    expect(offerMatchesFilters(row({ priceMin: 80000, priceMax: 80000 }), f, NOW)).toBe(false);
    expect(offerMatchesFilters(row({ platform: 'instagram' }), f, NOW)).toBe(false);
    expect(offerMatchesFilters(row({ capturedAt: '2026-01-01T00:00:00.000Z' }), f, NOW)).toBe(false);
  });

  it('conditions must hold on one offer, not across offers', () => {
    const f = filters({ platform: 'telegram', priceRubMax: 50000 });
    const tgExpensive = row({ id: 'a', priceMin: 80000, priceMax: 80000 });
    const igCheap = row({ id: 'b', platform: 'instagram', priceMin: 30000, priceMax: 30000 });
    expect(profileMatchesOfferFilters([tgExpensive, igCheap], f, NOW)).toBe(false);
    expect(profileMatchesOfferFilters([tgExpensive, row({ id: 'c', priceMin: 40000, priceMax: 40000 })], f, NOW)).toBe(true);
  });

  it('price cap uses normalized ₽ with RUB raw fallback; unnormalized fx is outside', () => {
    const f = filters({ priceRubMax: 50000 });
    // Pre-9g RUB row (no normalized columns) → raw price counts.
    expect(offerMatchesFilters(row(), f, NOW)).toBe(true);
    // Normalized USD row counts at its ₽ value.
    expect(offerMatchesFilters(row({ currency: 'USD', priceMin: 400, priceRubMin: 36960 }), f, NOW)).toBe(true);
    // Unnormalized USD row: $400 must NOT pass as «400 ₽».
    expect(offerMatchesFilters(row({ currency: 'USD', priceMin: 400 }), f, NOW)).toBe(false);
  });

  it('superseded and low_confidence rows never match', () => {
    const f = filters({ kind: 'post' });
    expect(offerMatchesFilters(row({ status: 'superseded' }), f, NOW)).toBe(false);
    expect(offerMatchesFilters(row({ status: 'low_confidence' }), f, NOW)).toBe(false);
  });

  it('no filters ⇒ every profile matches (byte-identity guarantee)', () => {
    expect(profileMatchesOfferFilters([], filters(), NOW)).toBe(true);
  });
});

describe('staleness', () => {
  it('labels offers older than the rate-card TTL, never hides them', () => {
    const fresh = { capturedAt: '2026-06-01T00:00:00.000Z' };
    const old = { capturedAt: '2025-09-01T00:00:00.000Z' };
    const labeled = labelOfferStaleness([fresh, old], NOW);
    expect(labeled).toHaveLength(2);
    expect(labeled[0]!.stale).toBe(false);
    expect(labeled[1]!.stale).toBe(true);
    expect(isOfferStale('2025-09-01T00:00:00.000Z', NOW)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Pre-cut superset parity (catalog-sql-search D4)                    */
/* ------------------------------------------------------------------ */

const brief = (over: Partial<AdBrief> = {}): AdBrief =>
  ({
    id: 'b',
    topic: 'крипта',
    audienceTarget: '',
    budget: 30000,
    formats: ['telegram пост'],
    geo: [],
    deadline: null,
    notes: '',
    createdAt: '2026-06-01T00:00:00.000Z',
  }) as unknown as AdBrief;

function profileFromRows(id: string, rows: PlacementOfferRowLike[]): MatchableProfile {
  return {
    id,
    topics: ['крипта'],
    languages: [],
    formats: ['telegram_post'],
    audience: {},
    rateCards: [],
    placementOffers: composeOffersFromRows(rows),
    reach: null,
    avgViews: null,
  } as unknown as MatchableProfile;
}

describe('precutIncludesProfile ⊇ in-memory shortlist (superset parity)', () => {
  // The tricky fixtures from the design: every profile the in-memory
  // shortlist would PASS must be INCLUDED by the pre-cut predicate.
  const fixtures: Array<{ name: string; rows: PlacementOfferRowLike[] }> = [
    { name: 'no rows at all (legacy rateCards profile)', rows: [] },
    {
      name: 'only low_confidence rows (rolled offers empty ⇒ legacy path)',
      rows: [row({ status: 'low_confidence', confidence: 0.1 })],
    },
    { name: 'under-budget priced offer', rows: [row({ priceMin: 21000, priceMax: 21000 })] },
    { name: 'over-budget priced offer', rows: [row({ priceMin: 80000, priceMax: 80000 })] },
    {
      name: 'over-budget relevant + priceless term-only offer',
      rows: [
        row({ id: 'a', priceMin: 80000, priceMax: 80000 }),
        row({ id: 'b', priceMin: null, priceMax: null, rawSnippet: 'условия в лс', identityKey: 'telegram|post|month|||' }),
      ],
    },
    {
      name: 'unnormalized USD offer (price-unknown in ₽ terms)',
      rows: [row({ currency: 'USD', priceMin: 400, priceMax: 400 })],
    },
    {
      name: 'mixed: superseded cheap + active expensive',
      rows: [
        row({ id: 'old', status: 'superseded', priceMin: 20000, priceMax: 20000 }),
        row({ id: 'new', priceMin: 90000, priceMax: 90000 }),
      ],
    },
  ];

  it.each(fixtures.map((f) => [f.name, f.rows] as const))('%s', (_name, rows) => {
    const p = profileFromRows('p', rows);
    const shortlisted = isShortlisted(brief(), p, { useStructuredOffers: true }).ok;
    const included = precutIncludesProfile(rows, 30000);
    // Superset: pre-cut may include more, NEVER less.
    if (shortlisted) expect(included).toBe(true);
  });

  it('pre-cut still excludes the all-priced-over-budget profile the shortlist excludes', () => {
    const rows = [row({ priceMin: 80000, priceMax: 80000 })];
    expect(isShortlisted(brief(), profileFromRows('p', rows), { useStructuredOffers: true }).ok).toBe(false);
    expect(precutIncludesProfile(rows, 30000)).toBe(false);
  });
});
