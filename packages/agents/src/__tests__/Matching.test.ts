import { describe, expect, it } from 'vitest';

import {
  prefilter,
  isShortlisted,
  rankProfiles,
  scoreProfile,
  relevantRates,
  budgetScore,
  type AdBrief,
  type MatchableProfile,
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
