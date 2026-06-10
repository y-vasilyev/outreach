import { describe, expect, it } from 'vitest';

import {
  prefilter,
  isShortlisted,
  rankProfiles,
  scoreProfile,
  relevantRates,
  budgetScore,
  structuredPlacementScore,
  parseBriefPlacementWants,
  type AdBrief,
  type MatchableProfile,
  type PlacementOffer,
} from '@nosquare/shared';

/**
 * Pure deterministic matching engine (agency-sourcing-matching M7, design D6,
 * task 7.6). These exercise the prefilter exclusion + budget-aware scoring
 * directly — no DB, no LLM. The engine lives in `@nosquare/shared/matching`.
 */
function mkBrief(over: Partial<AdBrief> = {}): AdBrief {
  return {
    id: 'brief1',
    topic: 'крипта',
    audienceTarget: '',
    budget: null,
    formats: [],
    geo: [],
    deadline: null,
    notes: '',
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function mkProfile(over: Partial<MatchableProfile> & { id: string }): MatchableProfile {
  return {
    topics: [],
    languages: [],
    formats: [],
    audience: {},
    rateCards: [],
    reach: null,
    avgViews: null,
    ...over,
  };
}

describe('prefilter exclusion', () => {
  it('excludes a profile with neither the geo nor the format the brief targets', () => {
    // Spec scenario: brief geo=RU, format=reels; profile offers neither.
    const brief = mkBrief({ topic: 'фитнес', geo: ['RU'], formats: ['reels'] });
    const offTopicGeo = mkProfile({
      id: 'p_no_geo',
      topics: ['фитнес'],
      formats: ['reels'],
      audience: { geo: { Германия: 1 } },
    });
    const noFormat = mkProfile({
      id: 'p_no_format',
      topics: ['фитнес'],
      formats: ['пост'],
      audience: { geo: { RU: 1 } },
    });
    const ok = mkProfile({
      id: 'p_ok',
      topics: ['фитнес'],
      formats: ['reels'],
      audience: { geo: { RU: 0.9 } },
    });

    const shortlist = prefilter(brief, [offTopicGeo, noFormat, ok]);
    expect(shortlist.map((p) => p.id)).toEqual(['p_ok']);
    expect(isShortlisted(brief, offTopicGeo).reason).toMatch(/geo/);
    expect(isShortlisted(brief, noFormat).reason).toMatch(/format/);
  });

  it('excludes off-topic profiles before scoring', () => {
    const brief = mkBrief({ topic: 'крипта' });
    const cooking = mkProfile({ id: 'cook', topics: ['кулинария', 'рецепты'] });
    expect(isShortlisted(brief, cooking).ok).toBe(false);
  });

  it('excludes a profile whose cheapest relevant rate exceeds the budget', () => {
    const brief = mkBrief({ topic: 'крипта', budget: 10000, formats: ['пост'] });
    const tooPricey = mkProfile({
      id: 'pricey',
      topics: ['крипта'],
      formats: ['пост'],
      rateCards: [{ format: 'пост', price: 25000, currency: 'RUB' }],
    });
    expect(isShortlisted(brief, tooPricey).ok).toBe(false);
    expect(isShortlisted(brief, tooPricey).reason).toMatch(/budget/);
  });
});

describe('budget-aware ranking', () => {
  it('ranks the budget-fitting profile higher and references rate-card fit in the rationale', () => {
    // Two otherwise-equal profiles differing only in rate card.
    const brief = mkBrief({ topic: 'крипта', budget: 20000, formats: ['пост'], geo: ['RU'] });
    const cheap = mkProfile({
      id: 'cheap',
      topics: ['крипта'],
      formats: ['пост'],
      audience: { geo: { RU: 1 } },
      reach: 50000,
      rateCards: [{ format: 'пост', price: 8000, currency: 'RUB' }],
    });
    const pricey = mkProfile({
      id: 'pricey',
      topics: ['крипта'],
      formats: ['пост'],
      audience: { geo: { RU: 1 } },
      reach: 50000,
      rateCards: [{ format: 'пост', price: 18000, currency: 'RUB' }],
    });

    const ranked = rankProfiles(brief, [pricey, cheap]);
    expect(ranked[0]?.profileId).toBe('cheap');
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
    // Rationale references the rate-card fit.
    expect(ranked[0]?.rationale).toMatch(/бюджет/);
    expect(ranked[0]?.rationale).toMatch(/8000/);
  });

  it('a profile over budget never makes the shortlist regardless of topic fit', () => {
    const brief = mkBrief({ topic: 'крипта', budget: 5000, formats: ['пост'] });
    const ranked = rankProfiles(brief, [
      mkProfile({
        id: 'over',
        topics: ['крипта'],
        formats: ['пост'],
        rateCards: [{ format: 'пост', price: 50000, currency: 'RUB' }],
      }),
    ]);
    expect(ranked).toHaveLength(0);
  });

  it('does not budget-exclude on an unrelated format rate card (S5)', () => {
    // Brief wants reels under 10k; profile only has a CHEAP "пост" card and no
    // reels. The cheap пост price must NOT be used for the reels budget check —
    // relevance (not budget) governs. relevantRates is empty → budget neutral.
    const brief = mkBrief({ topic: 'крипта', budget: 10000, formats: ['reels'] });
    const profile = mkProfile({
      id: 'no_reels',
      topics: ['крипта'],
      formats: ['пост'],
      rateCards: [{ format: 'пост', price: 3000, currency: 'RUB' }],
    });
    expect(relevantRates(brief, profile)).toEqual([]);
    // Budget is neutral (not "fits" via an unrelated cheap card, not "over").
    const b = budgetScore(brief, profile);
    expect(b.minRate).toBeUndefined();
    // Excluded — but by FORMAT (no reels), not budget.
    const decision = isShortlisted(brief, profile);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/format/);
  });

  it('does not let an unrelated EXPENSIVE card wrongly exclude on budget (S5)', () => {
    // Profile offers the requested "пост" cheaply AND an unrelated pricey
    // "интеграция". The budget check must use only the relevant "пост" rate.
    const brief = mkBrief({ topic: 'крипта', budget: 10000, formats: ['пост'] });
    const profile = mkProfile({
      id: 'mixed',
      topics: ['крипта'],
      formats: ['пост', 'интеграция'],
      rateCards: [
        { format: 'пост', price: 5000, currency: 'RUB' },
        { format: 'интеграция', price: 99000, currency: 'RUB' },
      ],
    });
    expect(relevantRates(brief, profile).map((r) => r.format)).toEqual(['пост']);
    expect(budgetScore(brief, profile).fits).toBe(true);
    expect(isShortlisted(brief, profile).ok).toBe(true);
  });

  it('produces scores within [0,1]', () => {
    const brief = mkBrief({ topic: 'крипта', budget: 20000, formats: ['пост'], geo: ['RU'] });
    const s = scoreProfile(
      brief,
      mkProfile({
        id: 'x',
        topics: ['крипта'],
        formats: ['пост'],
        audience: { geo: { RU: 1 } },
        rateCards: [{ format: 'пост', price: 8000, currency: 'RUB' }],
      }),
    );
    expect(s.score).toBeGreaterThanOrEqual(0);
    expect(s.score).toBeLessThanOrEqual(1);
  });
});

/* ------------------------------------------------------------------ */
/* Structured placement offers (entity-style-rate-cards, task 5.1/5.2) */
/* ------------------------------------------------------------------ */

function mkOffer(over: Partial<PlacementOffer> = {}): PlacementOffer {
  return {
    kind: 'post',
    platform: 'telegram',
    price: 10000,
    currency: 'RUB',
    attributes: [],
    confidence: 0.9,
    rawSnippet: '',
    rawPrice: '',
    sourceMessageId: null,
    extractedBy: 'llm',
    capturedAt: null,
    ...over,
  };
}

function attr(key: string, value: PlacementOffer['attributes'][number]['value']) {
  return { key, value, confidence: 1, rawSnippet: '' };
}

describe('budget in normalized RUB (price-normalization-v2)', () => {
  it('a USD offer is evaluated at its ₽ value, not the raw number', () => {
    const brief = mkBrief({ topic: 'крипта', formats: ['telegram пост'], geo: [], budget: 30000 });
    const usdProfile = mkProfile({
      id: 'usd',
      topics: ['крипта'],
      formats: ['telegram_post'],
      placementOffers: [
        mkOffer({
          price: 400,
          currency: 'USD',
          normalized: {
            priceRubMin: 36960,
            priceRubMax: 36960,
            cpmRub: 3696,
            fxRateUsed: 92.4,
            fxAsOf: '2026-06-01T00:00:00.000Z',
            viewsBasis: 10000,
            viewsSource: 'post_insights',
          },
        }),
      ],
    });
    // Raw comparison (400 < 30000) would wrongly shortlist; ₽ value exceeds.
    const res = isShortlisted(brief, usdProfile, { useStructuredOffers: true });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/36960/);
    // CPM + fx provenance surface as informational signals.
    const scored = scoreProfile(brief, usdProfile, { useStructuredOffers: true });
    expect(scored.placement).toEqual({
      cpmRub: 3696,
      currency: 'USD',
      fxAsOf: '2026-06-01T00:00:00.000Z',
    });
    expect(scored.rationale).toMatch(/CPM/);
  });

  it('unnormalized offers fall back to the raw price (pre-migration behavior)', () => {
    const brief = mkBrief({ topic: 'крипта', formats: ['telegram пост'], geo: [], budget: 30000 });
    const plain = mkProfile({
      id: 'plain',
      topics: ['крипта'],
      formats: ['telegram_post'],
      placementOffers: [mkOffer({ price: 21000 })],
    });
    expect(isShortlisted(brief, plain, { useStructuredOffers: true }).ok).toBe(true);
    expect(scoreProfile(brief, plain, { useStructuredOffers: true }).placement).toMatchObject({
      cpmRub: null,
      currency: 'RUB',
    });
  });
});

describe('structured placement matching', () => {
  // Brief wants a long-lived Telegram post.
  const brief = mkBrief({ topic: 'крипта', formats: ['telegram пост месяц'], geo: [] });

  const longLived = mkProfile({
    id: 'long',
    topics: ['крипта'],
    formats: ['telegram_post_day', 'telegram_post_month'],
    reach: 50000,
    placementOffers: [
      mkOffer({ price: 13000, attributes: [attr('duration', 'day')] }),
      mkOffer({ price: 21000, attributes: [attr('duration', 'month')] }),
    ],
  });
  const oneDayOnly = mkProfile({
    id: 'day',
    topics: ['крипта'],
    formats: ['telegram_post_day'],
    reach: 50000,
    placementOffers: [mkOffer({ price: 13000, attributes: [attr('duration', 'day')] })],
  });

  it('ranks a long-lived post above a one-day post (flag on)', () => {
    const ranked = rankProfiles(brief, [oneDayOnly, longLived], { useStructuredOffers: true });
    expect(ranked[0]?.profileId).toBe('long');
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it('cites the placement terms that drove selection in the rationale', () => {
    const s = scoreProfile(brief, longLived, { useStructuredOffers: true });
    // Mentions structured terms (telegram / пост / месяц) not just a flat format.
    expect(s.rationale).toMatch(/условия:/);
    expect(s.rationale).toMatch(/telegram/);
    expect(s.rationale).toMatch(/месяц/);
  });

  it('permanent delete_policy counts as long-lived even without duration=month', () => {
    const permanent = mkProfile({
      id: 'perm',
      topics: ['крипта'],
      reach: 50000,
      placementOffers: [
        mkOffer({ price: 15000, attributes: [attr('duration', 'day'), attr('delete_policy', 'permanent')] }),
      ],
    });
    const ranked = rankProfiles(brief, [oneDayOnly, permanent], { useStructuredOffers: true });
    expect(ranked[0]?.profileId).toBe('perm');
  });

  it('falls back to legacy rateCards when a profile has no offers (flag on)', () => {
    const legacy = mkProfile({
      id: 'legacy',
      topics: ['крипта'],
      formats: ['пост'],
      rateCards: [{ format: 'пост', price: 8000, currency: 'RUB' }],
    });
    const legacyBrief = mkBrief({ topic: 'крипта', budget: 20000, formats: ['пост'] });
    const s = scoreProfile(legacyBrief, legacy, { useStructuredOffers: true });
    // Legacy rationale shape (форматы / бюджет with the rate-card price).
    expect(s.rationale).toMatch(/форматы:|бюджет:/);
    expect(s.rationale).toMatch(/8000/);
  });

  it('flag off → structured offers ignored, byte-identical legacy behavior', () => {
    // Same profile scored with the flag off must equal a no-offers profile.
    const withOffers = mkProfile({
      id: 'p',
      topics: ['крипта'],
      formats: ['пост'],
      rateCards: [{ format: 'пост', price: 8000, currency: 'RUB' }],
      placementOffers: [mkOffer({ price: 21000, attributes: [attr('duration', 'month')] })],
    });
    const withoutOffers = mkProfile({
      id: 'p',
      topics: ['крипта'],
      formats: ['пост'],
      rateCards: [{ format: 'пост', price: 8000, currency: 'RUB' }],
    });
    const b = mkBrief({ topic: 'крипта', budget: 20000, formats: ['пост'] });
    const a = scoreProfile(b, withOffers); // default opts: flag off
    const c = scoreProfile(b, withoutOffers);
    expect(a.score).toBe(c.score);
    expect(a.rationale).toBe(c.rationale);
  });

  it('over-budget structured offer is excluded by the prefilter', () => {
    const pricey = mkProfile({
      id: 'pricey',
      topics: ['крипта'],
      placementOffers: [mkOffer({ price: 50000, attributes: [attr('duration', 'month')] })],
    });
    const budgetBrief = mkBrief({ topic: 'крипта', budget: 10000, formats: ['telegram пост месяц'] });
    const decision = isShortlisted(budgetBrief, pricey, { useStructuredOffers: true });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/budget/);
  });

  it('offsite review with included deliverables: rationale lists the deliverables', () => {
    // Spec scenario: selected because it offers an offsite review that includes
    // a permanent post and event announcement → rationale mentions those terms.
    const reviewBrief = mkBrief({ topic: 'крипта', formats: ['обзор анонс'] });
    const reviewer = mkProfile({
      id: 'reviewer',
      topics: ['крипта'],
      placementOffers: [
        mkOffer({
          kind: 'offsite_review',
          platform: null,
          price: 30000,
          attributes: [attr('delete_policy', 'permanent'), attr('includes', ['анонс мероприятия'])],
        }),
      ],
    });
    const s = scoreProfile(reviewBrief, reviewer, { useStructuredOffers: true });
    expect(s.rationale).toMatch(/выездной обзор/);
    expect(s.rationale).toMatch(/анонс/);
  });

  it('parseBriefPlacementWants extracts platform/kind/duration/deliverables', () => {
    const wants = parseBriefPlacementWants(
      mkBrief({ formats: ['telegram пост месяц'], notes: 'нужен анонс без удаления' }),
    );
    expect(wants.platform).toBe('telegram');
    expect(wants.kind).toBe('post');
    expect(wants.minDurationRank).toBeGreaterThan(1);
    expect(wants.wantsPermanent).toBe(true);
    expect(wants.deliverables).toContain('анонс');
  });

  it('structuredPlacementScore picks the longest-lived relevant offer as best', () => {
    const res = structuredPlacementScore(brief, longLived.placementOffers ?? []);
    expect(res.hasRelevant).toBe(true);
    expect(res.best?.durationLabel).toBe('month');
    expect(res.bestSummary).toMatch(/месяц/);
  });
});
