import { describe, expect, it } from 'vitest';

import { buildSafetyInput } from '../safety-input.js';

/**
 * `buildSafetyInput` is the single source of truth for the SafetyFilter
 * input across dispatcher / agent-run / operator-approve / direct-send
 * (harden-agency-sourcing-pipeline → `campaign-type-registry` spec). Tests
 * here pin the helper's behaviour; the workers/api integration tests then
 * just assert that each call site delegates to it. That gives us the
 * "input parity" invariant without having to spin up every call site in
 * one test.
 */
describe('buildSafetyInput', () => {
  const safetyProfile = {
    max_length: 800,
    allow_links: false,
    forbidden_topics: ['гарантируем результат', 'оплатите по ссылке'],
    allowed_topics: ['реклама', 'интеграция', 'прайс'],
    hard_block_patterns: [
      {
        id: 'agency_guarantee',
        pattern: 'гарантиру[а-я]+',
        reason: 'обещание результата запрещено',
      },
    ],
  };

  it('returns the legacy shape when campaign_types is off (no overrides, no topic lists)', () => {
    const bundle = buildSafetyInput({
      draft: 'привет',
      campaignTypesEnabled: false,
      safetyProfile,
    });
    expect(bundle.input).toEqual({ draft: 'привет' });
    expect(bundle.overrides).toBeUndefined();
  });

  it('returns the legacy shape when no safety profile is supplied', () => {
    const bundle = buildSafetyInput({
      draft: 'привет',
      campaignTypesEnabled: true,
      safetyProfile: null,
    });
    expect(bundle.input).toEqual({ draft: 'привет' });
    expect(bundle.overrides).toBeUndefined();
  });

  it('emits the FULL safety input when a profile is supplied + flag on', () => {
    const bundle = buildSafetyInput({
      draft: 'про прайс',
      campaignTypesEnabled: true,
      safetyProfile,
      channelAnalysis: { topic: 'travel' },
      contact: { id: 'c1' },
      campaign: { name: 'X' },
    });
    expect(bundle.input).toMatchObject({
      draft: 'про прайс',
      channel_analysis: { topic: 'travel' },
      contact: { id: 'c1' },
      campaign: { name: 'X' },
      forbidden_topics: ['гарантируем результат', 'оплатите по ссылке'],
      allowed_topics: ['реклама', 'интеграция', 'прайс'],
    });
    expect(bundle.input.hard_block_patterns).toEqual([
      {
        id: 'agency_guarantee',
        pattern: 'гарантиру[а-я]+',
        reason: 'обещание результата запрещено',
      },
    ]);
    expect(bundle.overrides).toEqual({ params: { max_length: 800, allow_links: false } });
  });

  it('is deterministic — same inputs produce structurally identical bundles', () => {
    const args = {
      draft: 'd',
      campaignTypesEnabled: true,
      safetyProfile,
      channelAnalysis: { topic: 't' },
      contact: { id: 'c' },
      campaign: { name: 'n' },
    };
    const a = buildSafetyInput(args);
    const b = buildSafetyInput(args);
    expect(a).toEqual(b);
  });

  it('forwards ajtbd_non_goals only when non-empty', () => {
    const withGoals = buildSafetyInput({
      draft: 'd',
      campaignTypesEnabled: true,
      safetyProfile,
      ajtbdNonGoals: ['продавать рекламу'],
    });
    expect(withGoals.input.ajtbd_non_goals).toEqual(['продавать рекламу']);
    const withoutGoals = buildSafetyInput({
      draft: 'd',
      campaignTypesEnabled: true,
      safetyProfile,
      ajtbdNonGoals: [],
    });
    expect(withoutGoals.input.ajtbd_non_goals).toBeUndefined();
  });
});
