import { describe, expect, it } from 'vitest';

import {
  resolveCapabilityMap,
  ROLE_TIER,
  DEFAULT_CAPABILITY_MAP,
} from '@nosquare/shared';

import {
  campaignTypeBuilder,
  campaignTypeBuilderOutputSchema,
  BUILDER_REQUIRED_ROLES,
} from '../agents/CampaignTypeBuilder.js';
import { makeCtx, makeConfig, makeLLM } from './_mocks.js';

/**
 * Builds a well-formed meta-agent output covering every required role. The
 * mocked LLM returns this so we exercise the agent's I/O validation and the
 * downstream draft-shaping logic without a live model.
 */
function fullDraftOutput() {
  return {
    key: 'podcast_guesting',
    name: 'Гостевание в подкастах',
    description: 'Договориться о госте в подкасте. Не продажа.',
    goalSchema: {
      type: 'object',
      required: ['target_shows'],
      properties: { target_shows: { type: 'array', items: { type: 'string' } } },
    },
    safetyProfile: {
      forbidden_topics: ['гарантия'],
      allowed_topics: ['подкаст', 'выпуск', 'гость'],
      allow_links: false,
      max_length: 700,
    },
    autonomyPolicy: {
      defaultMode: 'assisted',
      T_safety: 0.8,
      T_semi_auto_goalfit: 0.6,
      T_auto_goalfit: 0.75,
      forceHandoffIntents: ['discusses_price'],
    },
    agents: BUILDER_REQUIRED_ROLES.map((role) => ({
      role,
      description: `agent for ${role}`,
      systemPrompt: `system prompt for ${role} {{x}}`,
      userPromptTemplate: `user prompt for ${role} {{x}}`,
      outputJsonSchema:
        role === 'intent_classifier' || role === 'safety_filter' || role === 'goal_fit_evaluator'
          ? { type: 'object' }
          : null,
    })),
  };
}

describe('campaign_type_builder agent', () => {
  it('produces a complete draft: goal schema, safety profile, one agent per required role', async () => {
    const llm = makeLLM({ completeJsonImpl: () => fullDraftOutput() });
    const ctx = makeCtx({ llm, config: makeConfig({ name: 'campaign_type_builder' }) });

    const out = await campaignTypeBuilder.run(
      {
        goal_description: 'Договориться о гостевом эпизоде в нишевых подкастах',
        examples: [],
        constraints: {},
        required_roles: [...BUILDER_REQUIRED_ROLES],
      },
      ctx,
    );

    // Validates against the output schema (re-parse to be explicit).
    const parsed = campaignTypeBuilderOutputSchema.parse(out);
    expect(parsed.goalSchema).toBeTruthy();
    expect(parsed.safetyProfile.allowed_topics).toContain('подкаст');
    expect(parsed.autonomyPolicy.defaultMode).toBe('assisted');
    // One drafted agent per required pipeline role.
    const roles = parsed.agents.map((a) => a.role).sort();
    expect(roles).toEqual([...BUILDER_REQUIRED_ROLES].sort());
    // Structured roles carry an output JSON-schema; composers do not.
    const intent = parsed.agents.find((a) => a.role === 'intent_classifier');
    expect(intent?.outputJsonSchema).not.toBeNull();
    const opening = parsed.agents.find((a) => a.role === 'opening_composer');
    expect(opening?.outputJsonSchema).toBeNull();
    expect(llm._calls.completeJson).toBe(1);
  });
});

describe('capability map tier selection (3.1 / 3.3)', () => {
  it('binds a role to an endpoint of the right tier when all tiers exist', () => {
    const endpoints = [{ id: 'ep_or', provider: 'openrouter', enabled: true }];
    const res = resolveCapabilityMap(endpoints);
    expect(res.cheap.available).toBe(true);
    expect(res.strong.available).toBe(true);
    // strong tier resolves to the OpenRouter strong model from the default map.
    expect(res.strong.model).toBe(DEFAULT_CAPABILITY_MAP.openrouter!.strong);
    expect(res.strong.endpointId).toBe('ep_or');
    // opening_composer is a strong-tier role.
    expect(ROLE_TIER.opening_composer).toBe('strong');
  });

  it('reports a tier as unavailable instead of emitting a dangling reference', () => {
    // A provider that has NO entry in the capability map → every tier unresolved.
    const endpoints = [{ id: 'ep_x', provider: 'unknown_provider', enabled: true }];
    const res = resolveCapabilityMap(endpoints);
    for (const tier of ['cheap', 'medium', 'strong'] as const) {
      expect(res[tier].available).toBe(false);
      expect(res[tier].endpointId).toBeNull();
      expect(res[tier].model).toBeNull();
    }
  });

  it('skips disabled endpoints', () => {
    const endpoints = [{ id: 'ep_or', provider: 'openrouter', enabled: false }];
    const res = resolveCapabilityMap(endpoints);
    expect(res.medium.available).toBe(false);
  });

  it('prefers the first listed endpoint that maps a tier', () => {
    const endpoints = [
      { id: 'ep_yandex', provider: 'yandex', enabled: true },
      { id: 'ep_or', provider: 'openrouter', enabled: true },
    ];
    const res = resolveCapabilityMap(endpoints);
    // yandex is listed first and maps every tier, so it wins.
    expect(res.cheap.endpointId).toBe('ep_yandex');
    expect(res.cheap.provider).toBe('yandex');
  });
});
