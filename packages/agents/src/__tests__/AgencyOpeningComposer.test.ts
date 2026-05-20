import { describe, expect, it } from 'vitest';

import { agencyOpeningComposer } from '../agents/AgencyOpeningComposer.js';
import { makeCtx, makeConfig, makeLLM } from './_mocks.js';

/**
 * AgencyOpeningComposer (agency-sourcing-matching task 4.2/4.6):
 *   - cites a REAL observed integration when one exists;
 *   - refuses to fabricate a past ad when none exist (no auto-send-eligible
 *     variant), even if the LLM hallucinates a brand.
 */
describe('agency_opening_composer', () => {
  const baseConfig = makeConfig({ systemPrompt: '', userPromptTemplate: '' });

  it('cites an observed integration and keeps it auto-send-eligible', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        variants: [
          {
            text: 'Здравствуйте! Мы агентство, видел вашу интеграцию с Skillbox. У клиента похожий запрос — расскажете про форматы и прайс?',
            rationale: 'Сослался на наблюдаемую интеграцию Skillbox.',
            length: 'medium',
            risk_score: 0.1,
            cited_integration: 'Skillbox',
            auto_send_eligible: true,
          },
        ],
      }),
    });
    const ctx = makeCtx({ llm, config: baseConfig });
    const out = await agencyOpeningComposer.run(
      {
        channel_analysis: { topic: 'edtech' },
        contact: {},
        campaign: { goal_text: 'интеграции для клиента из edtech', client_brief: '' },
        observed_integrations: [
          { brand: 'Skillbox', snippet: 'Реклама. Курс от Skillbox по дизайну', date: '2026-04-01' },
        ],
      },
      ctx,
    );
    expect(out.variants[0]!.cited_integration).toBe('Skillbox');
    expect(out.variants[0]!.auto_send_eligible).toBe(true);
    // The observed integration reached the prompt.
    expect(llm._calls.completeJson).toBe(1);
  });

  it('refuses fabrication: no observed integrations → not auto-send-eligible', async () => {
    // The LLM hallucinates a specific past ad even though we passed none.
    const llm = makeLLM({
      completeJsonImpl: () => ({
        variants: [
          {
            text: 'Здравствуйте! Видел вашу рекламу Tinkoff — у клиента похожий запрос.',
            rationale: 'invented',
            length: 'short',
            risk_score: 0.2,
            cited_integration: 'Tinkoff',
            auto_send_eligible: true,
          },
        ],
      }),
    });
    const ctx = makeCtx({ llm, config: baseConfig });
    const out = await agencyOpeningComposer.run(
      {
        channel_analysis: { topic: 'финансы' },
        contact: {},
        campaign: { goal_text: 'интеграции для клиента', client_brief: '' },
        observed_integrations: [],
      },
      ctx,
    );
    // Deterministic guard strips the fabricated citation + blocks auto-send.
    expect(out.variants[0]!.cited_integration).toBeUndefined();
    expect(out.variants[0]!.auto_send_eligible).toBe(false);
  });

  it('drops auto-send eligibility when the cited brand was not observed', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        variants: [
          {
            text: 'Видел вашу интеграцию с Ozon...',
            rationale: 'cites a brand not in the observed set',
            length: 'medium',
            risk_score: 0.1,
            cited_integration: 'Ozon',
            auto_send_eligible: true,
          },
        ],
      }),
    });
    const ctx = makeCtx({ llm, config: baseConfig });
    const out = await agencyOpeningComposer.run(
      {
        channel_analysis: { topic: 'tech' },
        contact: {},
        campaign: { goal_text: 'x', client_brief: '' },
        observed_integrations: [{ brand: 'Skillbox', snippet: 'курс Skillbox' }],
      },
      ctx,
    );
    // Observed integrations exist, but the variant cited a different brand.
    expect(out.variants[0]!.auto_send_eligible).toBe(false);
  });
});
