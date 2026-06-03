import { describe, expect, it } from 'vitest';

import { sponsoredIntegrationDetector } from '../agents/SponsoredIntegrationDetector.js';
import { makeCtx, makeLLM } from './_mocks.js';

/**
 * SponsoredIntegrationDetector (harden-agency-sourcing-pipeline). LLM-driven
 * classifier; we mock the LLM and assert the agent's post-process: it returns
 * what the LLM said, but drops integrations whose `snippet` does not actually
 * appear in any supplied post (the LLM occasionally paraphrases — we never
 * pass a paraphrased citation through).
 */
describe('sponsoredIntegrationDetector', () => {
  it('returns confirmed integrations with verbatim snippets', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        integrations: [
          {
            snippet: 'попробуйте курс Skillbox по промокоду WEB10',
            brand: 'Skillbox',
            confidence: 0.9,
            rationale: 'явный промокод + бренд',
          },
        ],
      }),
    });
    const out = await sponsoredIntegrationDetector.run(
      {
        posts: [
          { text: 'Сегодня про путешествия по Алтаю.' },
          { text: 'Сходил тут на курс — попробуйте курс Skillbox по промокоду WEB10, реально топ.' },
        ],
        channel_title: 'X',
        language: 'ru',
      },
      makeCtx({ llm }),
    );
    expect(out.integrations).toHaveLength(1);
    expect(out.integrations[0]?.snippet).toBe('попробуйте курс Skillbox по промокоду WEB10');
    expect(out.integrations[0]?.brand).toBe('Skillbox');
  });

  it('returns empty array when no posts are supplied (no LLM call)', async () => {
    const llm = makeLLM();
    const out = await sponsoredIntegrationDetector.run(
      { posts: [], channel_title: '', language: 'ru' },
      makeCtx({ llm }),
    );
    expect(out.integrations).toEqual([]);
    expect(llm._calls.completeJson).toBe(0);
  });

  it('drops integrations whose snippet does not appear in any supplied post', async () => {
    // LLM paraphrased a snippet — we never let the paraphrase through.
    const llm = makeLLM({
      completeJsonImpl: () => ({
        integrations: [
          {
            snippet: 'продвижение Skillbox с промокодом',
            confidence: 0.85,
            rationale: 'выглядит как реклама',
          },
        ],
      }),
    });
    const out = await sponsoredIntegrationDetector.run(
      {
        posts: [
          { text: 'попробуйте курс Skillbox по промокоду WEB10, реально топ' },
        ],
        channel_title: 'X',
        language: 'ru',
      },
      makeCtx({ llm }),
    );
    expect(out.integrations).toEqual([]);
  });

  it('preserves multiple integrations when each snippet is verbatim', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        integrations: [
          { snippet: 'купите подписку Tinkoff Pro', confidence: 0.85, rationale: 'cta' },
          { snippet: 'промокод TASTY10 на Яндекс Еду', confidence: 0.9, rationale: 'промокод' },
        ],
      }),
    });
    const out = await sponsoredIntegrationDetector.run(
      {
        posts: [
          { text: 'купите подписку Tinkoff Pro со скидкой 30%' },
          { text: 'промокод TASTY10 на Яндекс Еду — работает до конца недели' },
        ],
        channel_title: 'X',
        language: 'ru',
      },
      makeCtx({ llm }),
    );
    expect(out.integrations).toHaveLength(2);
  });
});
