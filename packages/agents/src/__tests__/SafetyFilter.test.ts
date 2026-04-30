import { describe, expect, it } from 'vitest';

import { safetyFilter } from '../agents/SafetyFilter.js';
import { makeCtx, makeConfig, makeLLM } from './_mocks.js';

describe('safety_filter — deterministic rules', () => {
  // Forbidden phrases are now SOFT signals: they raise risk_score but
  // don't block. Operators see the suggestion in the inbox with a yellow
  // bar. Previously we substring-matched single words like "реклама"
  // which fired on virtually every CustDev opener.
  it('flags drafts containing forbidden phrases but does not block', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({ allow: true, reasons: [], risk_score: 0.2 }),
    });
    const ctx = makeCtx({
      llm,
      config: makeConfig({
        params: {
          forbidden_topics: ['купить рекламу', 'оффер'],
          max_length: 600,
        },
      }),
    });
    const out = await safetyFilter.run(
      { draft: 'Привет, хочу предложить оффер по вашему каналу.' },
      ctx,
    );
    expect(out.allow).toBe(true);
    expect(out.reasons.some((r) => r.startsWith('forbidden_phrase:'))).toBe(true);
    expect(out.risk_score).toBeGreaterThan(0);
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

  // Leading emoji is a stylistic warning, not a deal-breaker. Operator
  // sees the suggestion with the warning surfaced.
  it('flags leading emoji as a soft signal', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({ allow: true, reasons: [], risk_score: 0.1 }),
    });
    const ctx = makeCtx({
      llm,
      config: makeConfig({ params: { forbidden_topics: [] } }),
    });
    const out = await safetyFilter.run(
      { draft: '👋 Привет, давайте познакомимся.' },
      ctx,
    );
    expect(out.allow).toBe(true);
    expect(out.reasons).toContain('leading_emoji');
    expect(out.risk_score).toBeGreaterThan(0);
  });

  // Exclamation in the first line is normal in Russian greetings ("Здравствуйте,
  // Иван!"). Flag it but never block — otherwise no opener variant ever
  // makes it through.
  it('does not block exclamation in first line', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({ allow: true, reasons: [], risk_score: 0.05 }),
    });
    const ctx = makeCtx({
      llm,
      config: makeConfig({ params: { forbidden_topics: [] } }),
    });
    const out = await safetyFilter.run({ draft: 'Привет! Как дела?' }, ctx);
    expect(out.allow).toBe(true);
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

  // No hard violations AND no soft signals → skip LLM entirely (cheap path).
  it('skips LLM on the clean happy path', async () => {
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
      { draft: 'Здравствуйте. Хочу позвать на короткое 20-минутное интервью.' },
      ctx,
    );
    expect(out.allow).toBe(true);
    expect(llm._calls.completeJson).toBe(0);
  });

  // Soft-signal present → LLM is asked for a nuance check.
  it('calls LLM when soft signals are present', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({ allow: true, reasons: [], risk_score: 0.2 }),
    });
    const ctx = makeCtx({
      llm,
      config: makeConfig({ params: { forbidden_topics: [] } }),
    });
    const out = await safetyFilter.run({ draft: 'Здравствуйте, Иван!' }, ctx);
    expect(out.allow).toBe(true);
    expect(llm._calls.completeJson).toBe(1);
  });
});
