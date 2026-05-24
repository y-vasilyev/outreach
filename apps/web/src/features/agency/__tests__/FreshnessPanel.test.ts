import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import FreshnessPanel from '../FreshnessPanel.vue';
import type { ProfileFreshness, ProfileFreshnessCategory } from '../types';

const CATEGORIES: ProfileFreshnessCategory[] = [
  'rateCards', 'audience', 'topics', 'languages', 'formats', 'reach', 'avgViews',
];

function makeFreshness(
  overrides: Partial<Record<ProfileFreshnessCategory, { stale: boolean; ageDays: number | null }>> = {},
): ProfileFreshness {
  // Sensible default: everything ok, ageDays=10. Tests override per category.
  const out = {} as ProfileFreshness;
  for (const k of CATEGORIES) out[k] = { stale: false, ageDays: 10 };
  return { ...out, ...overrides };
}

describe('FreshnessPanel', () => {
  it('renders one pill per category (7 total)', () => {
    const w = mount(FreshnessPanel, { props: { freshness: makeFreshness() } });
    const pills = w.findAll('.pill');
    expect(pills).toHaveLength(7);
  });

  it('renders all expected category labels', () => {
    const w = mount(FreshnessPanel, { props: { freshness: makeFreshness() } });
    const text = w.text();
    for (const label of ['Прайсы', 'Аудитория', 'Темы', 'Языки', 'Форматы', 'Охват', 'Ср. просмотры']) {
      expect(text).toContain(label);
    }
  });

  it('renders "нет данных" + ghost tone when ageDays is null', () => {
    const w = mount(FreshnessPanel, {
      props: { freshness: makeFreshness({ rateCards: { stale: true, ageDays: null } }) },
    });
    // Tone for "no observation" must be ghost; never warn/ok (would lie about
    // having data).
    const ghostPills = w.findAll('.pill.ghost');
    expect(ghostPills.length).toBeGreaterThanOrEqual(1);
    expect(ghostPills.some((p) => p.text().includes('нет данных'))).toBe(true);
  });

  it('renders "сегодня" + ok tone when ageDays is 0 and not stale', () => {
    const w = mount(FreshnessPanel, {
      props: { freshness: makeFreshness({ topics: { stale: false, ageDays: 0 } }) },
    });
    const okPills = w.findAll('.pill.ok');
    expect(okPills.some((p) => p.text().includes('сегодня'))).toBe(true);
  });

  it('renders "N д" for positive age', () => {
    const w = mount(FreshnessPanel, {
      props: { freshness: makeFreshness({ rateCards: { stale: false, ageDays: 42 } }) },
    });
    expect(w.text()).toContain('42 д');
  });

  it('uses warn tone whenever stale is true (even with a number ageDays)', () => {
    const w = mount(FreshnessPanel, {
      props: { freshness: makeFreshness({ audience: { stale: true, ageDays: 200 } }) },
    });
    const warnPills = w.findAll('.pill.warn');
    // The "Аудитория" section must be warn — otherwise the colour lies about
    // freshness vs the backend `stale` decision.
    expect(warnPills.some((p) => p.text().includes('200 д'))).toBe(true);
  });

  it('builds a tooltip combining label + status + age', () => {
    const w = mount(FreshnessPanel, {
      props: { freshness: makeFreshness({ rateCards: { stale: true, ageDays: 120 } }) },
    });
    const titles = w.findAll('[title]').map((el) => el.attributes('title') ?? '');
    expect(titles).toContain('Прайсы: устарело, 120 д');
  });

  it('tooltip for null age omits the age part', () => {
    const w = mount(FreshnessPanel, {
      props: { freshness: makeFreshness({ reach: { stale: true, ageDays: null } }) },
    });
    const titles = w.findAll('[title]').map((el) => el.attributes('title') ?? '');
    expect(titles).toContain('Охват: нет данных');
  });

  it('renders all three tones in one mount when input mixes states', () => {
    const w = mount(FreshnessPanel, {
      props: {
        freshness: makeFreshness({
          rateCards: { stale: false, ageDays: 10 },
          audience: { stale: true, ageDays: 200 },
          reach: { stale: true, ageDays: null },
        }),
      },
    });
    expect(w.find('.pill.ok').exists()).toBe(true);
    expect(w.find('.pill.warn').exists()).toBe(true);
    expect(w.find('.pill.ghost').exists()).toBe(true);
  });
});
