import { describe, expect, it } from 'vitest';

import {
  prefilter,
  isShortlisted,
  rankProfiles,
  scoreProfile,
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
