import { describe, expect, it } from 'vitest';

import { safetyFilter } from '../agents/SafetyFilter.js';
import { makeCtx, makeConfig, makeLLM } from './_mocks.js';

/**
 * SafetyFilter is now LLM-first: substring/phrase keyword search was removed
 * (it falsely blocked normal Russian openers and was easily evaded anyway).
 * Hard deterministic guards remain only for what the LLM cannot override:
 *   - draft over the TG char limit
 *   - naked URL in turn one
 *   - recipient already declined
 * Everything else flows to the LLM nuance check.
 */
describe('safety_filter — hard policy guards', () => {
  it('blocks overly long drafts without calling LLM', async () => {
    const llm = makeLLM();
    const ctx = makeCtx({
      llm,
      config: makeConfig({ params: { max_length: 50 } }),
    });
    const draft = 'a'.repeat(100);
    const out = await safetyFilter.run({ draft }, ctx);
    expect(out.allow).toBe(false);
    expect(out.reasons.some((r) => r.startsWith('max_length_exceeded'))).toBe(true);
    expect(llm._calls.completeJson).toBe(0);
  });

  it('blocks links when allow_links=false', async () => {
    const llm = makeLLM();
    const ctx = makeCtx({
      llm,
      config: makeConfig({ params: { allow_links: false } }),
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
    const ctx = makeCtx({ llm, config: makeConfig({}) });
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

  // Anything that isn't a hard block is delegated to the LLM. We verify
  // the hand-off; the LLM mock just rubber-stamps.
  it('delegates tone judgment to LLM when no hard blocks fire', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({ allow: true, reasons: [], risk_score: 0.1 }),
    });
    const ctx = makeCtx({ llm, config: makeConfig({}) });
    const out = await safetyFilter.run(
      { draft: 'Здравствуйте, Иван! Зову на 20-минутное интервью по нашему продукту.' },
      ctx,
    );
    expect(out.allow).toBe(true);
    expect(llm._calls.completeJson).toBe(1);
  });

  // Defensive coercion: LLM returns risk_score on a 0..10 scale ("7") or
  // 0..100 ("85") — the schema must accept and clamp.
  it('coerces risk_score from 0..10 / 0..100 scales', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({ allow: false, reasons: ['salesy'], risk_score: 7 }),
    });
    const ctx = makeCtx({ llm, config: makeConfig({}) });
    const out = await safetyFilter.run({ draft: 'окей' }, ctx);
    // 7 on a 0..100 percent scale → 0.07; on a 0..10 scale → 0.7. Either
    // way it must be in [0, 1].
    expect(out.risk_score).toBeGreaterThanOrEqual(0);
    expect(out.risk_score).toBeLessThanOrEqual(1);
  });
});
