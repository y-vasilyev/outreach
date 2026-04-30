import { describe, expect, it } from 'vitest';

import { safetyFilter } from '../agents/SafetyFilter.js';
import { makeCtx, makeConfig, makeLLM } from './_mocks.js';

describe('safety_filter — deterministic rules', () => {
  it('blocks drafts containing forbidden topics without calling LLM', async () => {
    const llm = makeLLM();
    const ctx = makeCtx({
      llm,
      config: makeConfig({
        params: { forbidden_topics: ['реклама', 'оффер'], max_length: 600 },
      }),
    });
    const out = await safetyFilter.run(
      { draft: 'Привет, хочу предложить оффер по вашему каналу.' },
      ctx,
    );
    expect(out.allow).toBe(false);
    expect(out.reasons.some((r) => r.startsWith('forbidden_topic:'))).toBe(true);
    expect(llm._calls.completeJson).toBe(0);
  });

  it('blocks overly long drafts without calling LLM', async () => {
    const llm = makeLLM();
    const ctx = makeCtx({
      llm,
      config: makeConfig({ params: { max_length: 50, forbidden_topics: [] } }),
    });
    const draft = 'a'.repeat(100);
    const out = await safetyFilter.run({ draft }, ctx);
    expect(out.allow).toBe(false);
    expect(out.reasons.some((r) => r.startsWith('max_length_exceeded'))).toBe(true);
    expect(llm._calls.completeJson).toBe(0);
  });

  it('blocks leading emoji without calling LLM', async () => {
    const llm = makeLLM();
    const ctx = makeCtx({
      llm,
      config: makeConfig({ params: { forbidden_topics: [] } }),
    });
    const out = await safetyFilter.run(
      { draft: '👋 Привет, давайте познакомимся.' },
      ctx,
    );
    expect(out.allow).toBe(false);
    expect(out.reasons).toContain('leading_emoji');
    expect(llm._calls.completeJson).toBe(0);
  });

  it('blocks exclamation in first line', async () => {
    const llm = makeLLM();
    const ctx = makeCtx({
      llm,
      config: makeConfig({ params: { forbidden_topics: [] } }),
    });
    const out = await safetyFilter.run({ draft: 'Привет! Как дела?' }, ctx);
    expect(out.allow).toBe(false);
    expect(out.reasons).toContain('exclamation_in_first_line');
  });

  it('blocks links when allow_links=false', async () => {
    const llm = makeLLM();
    const ctx = makeCtx({
      llm,
      config: makeConfig({
        params: { forbidden_topics: [], allow_links: false },
      }),
    });
    const out = await safetyFilter.run(
      { draft: 'Привет, посмотри https://nosquare.io' },
      ctx,
    );
    expect(out.allow).toBe(false);
    expect(out.reasons).toContain('link_not_allowed');
    expect(llm._calls.completeJson).toBe(0);
  });

  it('blocks if recipient previously declined', async () => {
    const llm = makeLLM();
    const ctx = makeCtx({
      llm,
      config: makeConfig({ params: { forbidden_topics: [] } }),
    });
    const out = await safetyFilter.run(
      {
        draft: 'Привет, может всё-таки обсудим?',
        history: [{ direction: 'in', text: 'не пишите мне больше', intent: 'declined' }],
      },
      ctx,
    );
    expect(out.allow).toBe(false);
    expect(out.reasons).toContain('recipient_declined_earlier');
  });

  it('falls through to LLM only when all hard rules pass', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        allow: true,
        reasons: [],
        risk_score: 0.1,
      }),
    });
    const ctx = makeCtx({
      llm,
      config: makeConfig({
        params: { forbidden_topics: [], allow_links: false },
      }),
    });
    const out = await safetyFilter.run(
      { draft: 'Здравствуйте. Хочу позвать вас на короткое 20-минутное интервью по нашему продукту.' },
      ctx,
    );
    expect(out.allow).toBe(true);
    expect(llm._calls.completeJson).toBe(1);
  });
});
