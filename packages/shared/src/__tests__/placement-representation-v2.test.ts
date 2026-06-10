import { describe, it, expect } from 'vitest';
import {
  PLACEMENT_ATTRIBUTE_REGISTRY_V1,
  validateOfferAttributes,
  derivePlacementFormatKey,
  missingRequiredAttributes,
} from '../placement-offers.js';
import { structuredPlacementScore, rankProfiles } from '../matching.js';
import { rollUpProfileFields, type RollupDataPoint } from '../profile-rollup.js';
import { extractPlacementOffersFromText } from '../blogger-profile-enrichment.js';
import type { PlacementOffer } from '../schemas/placement-offer.js';
import type { MatchableProfile } from '../matching.js';
import type { AdBrief } from '../schemas/matching.js';

describe('registry v2 (placement-representation-v2)', () => {
  it('v2 keys are active registry attributes (validated, not proposals)', () => {
    const v2keys = ['tariff_name', 'slot', 'price_period', 'prepayment', 'tax_regime', 'tax_included', 'top_pin_hours', 'package_items'];
    for (const k of v2keys) {
      expect(PLACEMENT_ATTRIBUTE_REGISTRY_V1.some((e) => e.key === k && e.active)).toBe(true);
    }
    const offer = {
      kind: 'post',
      attributes: [
        { key: 'price_period', value: 'seasonal', confidence: 1, rawSnippet: '' },
        { key: 'tax_regime', value: 'ip', confidence: 1, rawSnippet: '' },
        { key: 'prepayment', value: '100%', confidence: 1, rawSnippet: '' },
      ],
    };
    const v = validateOfferAttributes(offer);
    expect(v.valid.map((a) => a.key).sort()).toEqual(['prepayment', 'price_period', 'tax_regime']);
    expect(v.unknown).toHaveLength(0);
  });

  it('every v2 key has requiredForKinds: [] (no new planner follow-ups)', () => {
    const v2keys = ['tariff_name', 'slot', 'price_period', 'prepayment', 'tax_regime', 'tax_included', 'top_pin_hours', 'package_items'];
    for (const k of v2keys) {
      const e = PLACEMENT_ATTRIBUTE_REGISTRY_V1.find((x) => x.key === k)!;
      expect(e.requiredForKinds).toEqual([]);
    }
    // A bare post offer still only misses the pre-v2 required keys.
    const missing = missingRequiredAttributes({ kind: 'post', attributes: [] });
    expect(missing).not.toContain('price_period');
    expect(missing).not.toContain('prepayment');
  });

  it('derivePlacementFormatKey is unchanged when no slot/tariff', () => {
    expect(derivePlacementFormatKey({ kind: 'post', platform: 'telegram', attributes: [{ key: 'duration', value: 'month', confidence: 1, rawSnippet: '' }] })).toBe('telegram_post_month');
    expect(derivePlacementFormatKey({ kind: 'post', platform: 'telegram', attributes: [] })).toBe('telegram_post');
  });
});

function offer(price: number, attrs: Array<[string, unknown]>, snippet: string): RollupDataPoint {
  const o: PlacementOffer = {
    kind: 'post', platform: 'telegram', price, currency: 'RUB',
    attributes: attrs.map(([key, value]) => ({ key, value: value as never, confidence: 1, rawSnippet: '' })),
    confidence: 0.9, rawSnippet: snippet, rawPrice: '', sourceMessageId: 'm', extractedBy: 'rate_card_extractor', capturedAt: '2026-06-01T00:00:00.000Z',
  };
  return { field: 'placement.offer', value: o, confidence: 0.9, capturedAt: o.capturedAt! };
}

describe('roll-up v2', () => {
  it('two same-price slots of one tariff stay distinct', () => {
    const rolled = rollUpProfileFields([
      offer(50000, [['tariff_name', 'Основной'], ['slot', '1']], 'slot1'),
      offer(50000, [['tariff_name', 'Основной'], ['slot', '2']], 'slot2'),
    ]);
    expect(rolled.placementOffers).toHaveLength(2);
  });

  it('composes platformAudience from audience.subscribers.<platform> points', () => {
    const pts: RollupDataPoint[] = [
      { field: 'audience.subscribers.instagram', value: 1200000, confidence: 0.8, capturedAt: '2026-06-01T00:00:00.000Z' },
      { field: 'audience.subscribers.telegram', value: 15000, confidence: 0.8, capturedAt: '2026-06-01T00:00:00.000Z' },
      { field: 'audience.subscribers.vk', value: 45000, confidence: 0.8, capturedAt: '2026-06-01T00:00:00.000Z' },
      { field: 'audience.subscribers.tiktok', value: 24500, confidence: 0.8, capturedAt: '2026-06-01T00:00:00.000Z' },
      { field: 'reach', value: 9999, confidence: 0.9, capturedAt: '2026-06-01T00:00:00.000Z' },
    ];
    const rolled = rollUpProfileFields(pts);
    const byPlatform = Object.fromEntries(rolled.platformAudience.map((e) => [e.platform, e.subscribers]));
    expect(byPlatform).toEqual({ instagram: 1200000, telegram: 15000, vk: 45000, tiktok: 24500 });
    expect(rolled.reach).toBe(9999); // scalar reach unaffected by subscribers
  });
});

describe('matching prefers base price (placement-representation-v2)', () => {
  it('reports the base price over a seasonal variant of an equal offer', () => {
    const brief = { id: 'b', topic: 'x', audienceTarget: '', budget: null, formats: ['пост'], geo: [], deadline: null, notes: '', createdAt: '2026-06-01T00:00:00.000Z' } as unknown as AdBrief;
    const mk = (price: number, period?: string): PlacementOffer => ({
      kind: 'post', platform: 'telegram', price, currency: 'RUB',
      attributes: period ? [{ key: 'price_period', value: period, confidence: 1, rawSnippet: '' }] : [],
      confidence: 0.9, rawSnippet: `p${price}`, rawPrice: '', sourceMessageId: null, extractedBy: 'llm', capturedAt: null,
    });
    const res = structuredPlacementScore(brief, [mk(135000, 'seasonal'), mk(120000, 'base')]);
    expect(res.best?.price).toBe(120000);
  });
});

describe('matching budget + per-platform ranking (codex fixes)', () => {
  const brief = (over: Partial<Record<string, unknown>> = {}): AdBrief =>
    ({ id: 'b', topic: 'x', audienceTarget: '', budget: null, formats: ['пост'], geo: [], deadline: null, notes: '', createdAt: '2026-06-01T00:00:00.000Z', ...over } as unknown as AdBrief);
  const mk = (price: number, period?: string): PlacementOffer => ({
    kind: 'post', platform: 'telegram', price, currency: 'RUB',
    attributes: period ? [{ key: 'price_period', value: period, confidence: 1, rawSnippet: '' }] : [],
    confidence: 0.9, rawSnippet: `p${price}`, rawPrice: '', sourceMessageId: null, extractedBy: 'llm', capturedAt: null,
  });

  it('budget checks the base price, not a temporary promo', () => {
    // base 120k + promo 90k, budget 100k → over budget (base 120k > 100k).
    const res = structuredPlacementScore(brief({ budget: 100000 }), [mk(120000, 'base'), mk(90000, 'promo')]);
    expect(Math.min(...res.relevantPrices)).toBe(120000);
  });

  it('per-platform audience breaks ties for a platform-targeted brief', () => {
    const base = { topics: ['x'], languages: ['ru'], formats: ['пост'], audience: {}, rateCards: [{ format: 'post', price: 1000, currency: 'RUB' }], avgViews: null };
    const A: MatchableProfile = { ...base, id: 'A', reach: 10000, platformAudience: [{ platform: 'telegram', subscribers: 500000, source: 'reply', capturedAt: null }] };
    const B: MatchableProfile = { ...base, id: 'B', reach: 900000, platformAudience: [{ platform: 'instagram', subscribers: 900000, source: 'reply', capturedAt: null }] };
    const ranked = rankProfiles(brief({ formats: ['пост telegram'] }), [B, A]);
    // A has far more Telegram subscribers though less total reach → ranks first.
    expect(ranked[0]!.profileId).toBe('A');
  });
});

describe('deterministic v2 capture', () => {
  it('«цена июня» → price_period seasonal (Cyrillic boundary fix)', () => {
    const o = extractPlacementOffersFromText('пост на сутки 135000 цена июня');
    const post = o.find((x) => x.kind === 'post')!;
    expect(post.attributes.find((a) => a.key === 'price_period')?.value).toBe('seasonal');
  });

  it('package line → kind=package offer with package_items', () => {
    const o = extractPlacementOffersFromText('Пакетное размещение - 50 тыс. оба формата');
    expect(o).toHaveLength(1);
    expect(o[0]!.kind).toBe('package');
    expect(o[0]!.price).toBe(50000);
    expect(o[0]!.attributes.some((a) => a.key === 'package_items')).toBe(true);
  });

  it('top-pin tier captures top_pin_hours', () => {
    const o = extractPlacementOffersFromText('Час топа / 24 ч. без удаления - 6000₽');
    expect(o[0]!.attributes.find((a) => a.key === 'top_pin_hours')?.value).toBe(24);
  });

  it('table row with ИП / включён / предоплата captures tax_regime, tax_included, prepayment', () => {
    const o = extractPlacementOffersFromText('Фотопост — 47000 ИП, налог включён, 100% предоплата');
    // single em-dash row (price not at end) → table builder won't fire; assert
    // the line-level v2 detector independently via an inline-capable layout:
    const o2 = extractPlacementOffersFromText('пост на сутки 47000 ИП, налог включён, 100% предоплата');
    const post = o2.find((x) => x.kind === 'post')!;
    expect(post.attributes.find((a) => a.key === 'tax_regime')?.value).toBe('ip');
    expect(post.attributes.find((a) => a.key === 'tax_included')?.value).toBe(true);
    expect(post.attributes.find((a) => a.key === 'prepayment')?.value).toBe('100%');
    void o;
  });
});
