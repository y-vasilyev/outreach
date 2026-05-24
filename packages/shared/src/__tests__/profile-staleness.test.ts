import { describe, expect, it } from 'vitest';
import {
  PROFILE_FIELD_TTL_DAYS,
  classifyProfileField,
  computeProfileFreshness,
  isContributingValue,
  isProfileFieldStale,
} from '../profile-staleness.js';

const NOW = new Date('2026-05-24T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * DAY);

describe('classifyProfileField', () => {
  it.each([
    ['rate.story', 'rateCards'],
    ['rate.post', 'rateCards'],
    ['audience.geo', 'audience'],
    ['audience.age', 'audience'],
    ['reach', 'reach'],
    ['reach.story', 'reach'],
    ['views.avg', 'avgViews'],
    ['avg_views', 'avgViews'],
    ['views', 'avgViews'],
    ['views.30d', 'avgViews'],
    ['topics', 'topics'],
    ['topic', 'topics'],
    ['languages', 'languages'],
    ['language', 'languages'],
    ['formats', 'formats'],
    ['format', 'formats'],
  ] as const)('classifies %s as %s', (field, category) => {
    expect(classifyProfileField(field)).toBe(category);
  });

  it('returns null for unknown prefixes', () => {
    expect(classifyProfileField('mystery.field')).toBeNull();
    expect(classifyProfileField('')).toBeNull();
    expect(classifyProfileField('rate')).toBeNull(); // bare `rate` without `.<fmt>`
  });

  it('narrows audience to the dims rollup actually renders', () => {
    // rollUpProfileFields renders only audience.geo|age|gender today, so an
    // unrendered audience.<other> must not count toward audience freshness.
    expect(classifyProfileField('audience.income')).toBeNull();
    expect(classifyProfileField('audience.interests')).toBeNull();
  });
});

describe('isContributingValue', () => {
  it('treats numeric values as contributing for numeric categories', () => {
    expect(isContributingValue('rateCards', 5000)).toBe(true);
    expect(isContributingValue('rateCards', '5 000')).toBe(true); // string-numeric
    expect(isContributingValue('rateCards', 'договорная')).toBe(false);
    expect(isContributingValue('reach', 12000)).toBe(true);
    expect(isContributingValue('avgViews', '12k')).toBe(false);
  });

  it('requires a non-empty share record for audience', () => {
    expect(isContributingValue('audience', { RU: 0.9 })).toBe(true);
    expect(isContributingValue('audience', { unknown: 'foo' })).toBe(false);
    expect(isContributingValue('audience', {})).toBe(false);
    expect(isContributingValue('audience', null)).toBe(false);
    expect(isContributingValue('audience', ['RU'])).toBe(false);
  });

  it('requires a non-empty string list for topics/languages/formats', () => {
    expect(isContributingValue('topics', 'tech')).toBe(true);
    expect(isContributingValue('topics', ['tech', 'food'])).toBe(true);
    expect(isContributingValue('topics', '')).toBe(false);
    expect(isContributingValue('topics', [])).toBe(false);
    expect(isContributingValue('topics', ['  '])).toBe(false);
  });
});

describe('isProfileFieldStale', () => {
  it('returns false when within TTL', () => {
    expect(isProfileFieldStale('rate.story', daysAgo(89), NOW)).toBe(false);
    expect(isProfileFieldStale('audience.geo', daysAgo(179), NOW)).toBe(false);
    expect(isProfileFieldStale('topics', daysAgo(364), NOW)).toBe(false);
  });

  it('returns true past the TTL boundary', () => {
    expect(isProfileFieldStale('rate.story', daysAgo(91), NOW)).toBe(true);
    expect(isProfileFieldStale('audience.geo', daysAgo(181), NOW)).toBe(true);
    expect(isProfileFieldStale('topics', daysAgo(366), NOW)).toBe(true);
  });

  it('treats exactly-at-TTL as still fresh (not greater than)', () => {
    // The cutoff is `now - capturedAt > ttl`, so == TTL stays fresh.
    expect(isProfileFieldStale('rate.story', daysAgo(90), NOW)).toBe(false);
  });

  it('returns true when capturedAt is missing', () => {
    expect(isProfileFieldStale('rate.story', null, NOW)).toBe(true);
    expect(isProfileFieldStale('rate.story', undefined, NOW)).toBe(true);
  });

  it('returns true when capturedAt is an unparseable string', () => {
    expect(isProfileFieldStale('rate.story', 'not-a-date', NOW)).toBe(true);
  });

  it('returns true for an unknown field, regardless of timestamp', () => {
    expect(isProfileFieldStale('mystery', daysAgo(1), NOW)).toBe(true);
  });

  it('accepts ISO strings', () => {
    expect(
      isProfileFieldStale('rate.story', daysAgo(30).toISOString(), NOW),
    ).toBe(false);
  });
});

describe('computeProfileFreshness', () => {
  it('uses the newest contributing data point per category', () => {
    const dataPoints = [
      { field: 'rate.story', value: 3000, capturedAt: daysAgo(100) }, // > 90d → stale alone
      { field: 'rate.post', value: 7000, capturedAt: daysAgo(10) }, // fresh, newer
      { field: 'audience.geo', value: { RU: 0.9 }, capturedAt: daysAgo(50) },
      { field: 'topics', value: ['food'], capturedAt: daysAgo(30) },
    ];
    const f = computeProfileFreshness(dataPoints, NOW);
    expect(f.rateCards).toEqual({ stale: false, ageDays: 10 });
    expect(f.audience).toEqual({ stale: false, ageDays: 50 });
    expect(f.topics).toEqual({ stale: false, ageDays: 30 });
  });

  it('marks a section stale when only an old contributing point exists', () => {
    const f = computeProfileFreshness(
      [{ field: 'rate.story', value: 5000, capturedAt: daysAgo(120) }],
      NOW,
    );
    expect(f.rateCards.stale).toBe(true);
    expect(f.rateCards.ageDays).toBe(120);
  });

  it('ignores a fresh non-contributing point (mirrors rollup filters)', () => {
    // A fresh "договорная" rate.post does NOT make rateCards fresh while the
    // displayed rate card is still the older numeric point.
    const f = computeProfileFreshness(
      [
        { field: 'rate.post', value: 'договорная', capturedAt: daysAgo(1) },
        { field: 'rate.post', value: 5000, capturedAt: daysAgo(120) },
      ],
      NOW,
    );
    expect(f.rateCards.stale).toBe(true);
    expect(f.rateCards.ageDays).toBe(120);
  });

  it('does NOT cross-pollinate freshness across unrelated sections', () => {
    // A fresh rate.post must not make topics/languages/audience/reach/
    // avgViews fresh. `formats` is the deliberate exception (see test below
    // and `rollUpProfileFields`'s union of explicit formats + rate cards).
    const f = computeProfileFreshness(
      [{ field: 'rate.post', value: 5000, capturedAt: daysAgo(1) }],
      NOW,
    );
    expect(f.rateCards).toEqual({ stale: false, ageDays: 1 });
    for (const cat of ['audience', 'topics', 'languages', 'reach', 'avgViews'] as const) {
      expect(f[cat]).toEqual({ stale: true, ageDays: null });
    }
  });

  it('counts a usable rate.<format> point toward formats freshness too', () => {
    // Rollup derives displayed formats from rate cards as a fallback union.
    // If only a rate card source exists, formats freshness must follow it,
    // not stay stale-by-default.
    const f = computeProfileFreshness(
      [{ field: 'rate.post', value: 5000, capturedAt: daysAgo(7) }],
      NOW,
    );
    expect(f.formats).toEqual({ stale: false, ageDays: 7 });
  });

  it('formats freshness picks the newer of explicit format points vs rate cards', () => {
    const f = computeProfileFreshness(
      [
        { field: 'formats', value: ['post', 'story'], capturedAt: daysAgo(30) },
        { field: 'rate.post', value: 5000, capturedAt: daysAgo(5) },
      ],
      NOW,
    );
    // Rate card is newer → wins.
    expect(f.formats.ageDays).toBe(5);
  });

  it('ignores audience.<other> dims that rollup does not render', () => {
    // audience.income is currently not rendered by rollUpProfileFields, so
    // even a usable share record there must not mark audience fresh.
    const f = computeProfileFreshness(
      [{ field: 'audience.income', value: { '10-30k': 0.5 }, capturedAt: daysAgo(1) }],
      NOW,
    );
    expect(f.audience).toEqual({ stale: true, ageDays: null });
  });

  it('reports {stale:true, ageDays:null} for every section when no points', () => {
    const f = computeProfileFreshness([], NOW);
    for (const cat of Object.keys(PROFILE_FIELD_TTL_DAYS)) {
      const section = (f as Record<string, { stale: boolean; ageDays: number | null }>)[cat]!;
      expect(section.stale).toBe(true);
      expect(section.ageDays).toBeNull();
    }
  });

  it('ignores unknown field prefixes', () => {
    const f = computeProfileFreshness(
      [
        { field: 'mystery.field', value: 'anything', capturedAt: daysAgo(1) },
        { field: 'rate.story', value: 5000, capturedAt: daysAgo(120) },
      ],
      NOW,
    );
    expect(f.rateCards).toEqual({ stale: true, ageDays: 120 });
  });

  it('treats exactly-at-TTL as still fresh per section', () => {
    const f = computeProfileFreshness(
      [{ field: 'rate.story', value: 5000, capturedAt: daysAgo(90) }],
      NOW,
    );
    expect(f.rateCards).toEqual({ stale: false, ageDays: 90 });
  });

  it('accepts Date and ISO-string capturedAt interchangeably', () => {
    const f = computeProfileFreshness(
      [{ field: 'rate.story', value: 5000, capturedAt: daysAgo(5).toISOString() }],
      NOW,
    );
    expect(f.rateCards.ageDays).toBe(5);
  });

  it('clamps a negative age (clock skew) to 0', () => {
    const future = new Date(NOW.getTime() + 5 * DAY);
    const f = computeProfileFreshness(
      [{ field: 'rate.story', value: 5000, capturedAt: future }],
      NOW,
    );
    expect(f.rateCards.ageDays).toBe(0);
    expect(f.rateCards.stale).toBe(false);
  });
});
