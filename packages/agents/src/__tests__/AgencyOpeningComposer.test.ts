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

  it('publishes outputSchema that includes variantKey (so AgentRunner does not strip it)', () => {
    const parsed = agencyOpeningComposer.outputSchema.parse({
      variants: [
        {
          text: 't',
          rationale: 'r',
          length: 'short',
          risk_score: 0.1,
          auto_send_eligible: false,
          variantKey: 'A',
        },
      ],
    });
    expect(parsed.variants[0]!.variantKey).toBe('A');
  });

  it('rejects a variant whose text exceeds the 800-char cap (existing constraint preserved)', () => {
    const tooLong = 'x'.repeat(801);
    expect(() =>
      agencyOpeningComposer.outputSchema.parse({
        variants: [
          {
            text: tooLong,
            rationale: 'r',
            length: 'short',
            risk_score: 0.1,
            auto_send_eligible: false,
            variantKey: 'A',
          },
        ],
      }),
    ).toThrow(/≤800 chars/);
  });

  it('stamps alphabetical variantKey on every variant by default', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        variants: [
          { text: 'Hey, no brand here.', rationale: '', length: 'short', risk_score: 0.2 },
          { text: 'Generic format question.', rationale: '', length: 'medium', risk_score: 0.2 },
        ],
      }),
    });
    const ctx = makeCtx({ llm, config: baseConfig });
    const out = await agencyOpeningComposer.run(
      {
        channel_analysis: { topic: 'edtech' },
        contact: {},
        campaign: { goal_text: 'x', client_brief: '' },
        observed_integrations: [],
      },
      ctx,
    );
    expect(out.variants.map((v) => v.variantKey)).toEqual(['A', 'B']);
    // No-fabrication guard still in effect:
    expect(out.variants.every((v) => v.auto_send_eligible === false)).toBe(true);
  });

  it('preserves LLM-supplied variant_key and runs the no-fabrication guard around it', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        variants: [
          {
            text: 'Видел вашу интеграцию с Skillbox — расскажете про формат?',
            rationale: 'cites observed',
            length: 'medium',
            risk_score: 0.1,
            cited_integration: 'Skillbox',
            auto_send_eligible: true,
            variant_key: 'with_brand',
          },
          {
            text: 'Здравствуйте, мы агентство — расскажете про форматы и прайс?',
            rationale: 'generic hook',
            length: 'medium',
            risk_score: 0.15,
            auto_send_eligible: false,
            variant_key: 'concise',
          },
        ],
      }),
    });
    const ctx = makeCtx({ llm, config: baseConfig });
    const out = await agencyOpeningComposer.run(
      {
        channel_analysis: { topic: 'edtech' },
        contact: {},
        campaign: { goal_text: 'x', client_brief: '' },
        observed_integrations: [
          { brand: 'Skillbox', snippet: 'Реклама. Курс Skillbox по дизайну', date: '2026-04-01' },
        ],
      },
      ctx,
    );
    expect(out.variants[0]!.variantKey).toBe('with_brand');
    expect(out.variants[0]!.auto_send_eligible).toBe(true);
    expect(out.variants[1]!.variantKey).toBe('concise');
  });

  it('drops auto-send eligibility when the text does not contain the cited integration', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        variants: [
          {
            // cited_integration is a REAL observed brand, but the text talks
            // about something else entirely — the citation is divorced from
            // what would actually be sent.
            text: 'Здравствуйте! Мы агентство, у клиента есть интересный запрос — расскажете про форматы?',
            rationale: 'cited Skillbox but never mentions it in the text',
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
        campaign: { goal_text: 'x', client_brief: '' },
        observed_integrations: [{ brand: 'Skillbox', snippet: 'курс Skillbox' }],
      },
      ctx,
    );
    // Citation is real but absent from the text → conservative: not eligible.
    expect(out.variants[0]!.auto_send_eligible).toBe(false);
  });
});
