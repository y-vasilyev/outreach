import { describe, expect, it } from 'vitest';

import { goalFitEvaluator } from '../agents/GoalFitEvaluator.js';
import { makeCtx, makeConfig, makeLLM } from './_mocks.js';

const SAMPLE_AJTBD = {
  job: 'Провести 15-минутное CustDev-интервью с автором канала',
  when: 'Когда канал получает входящие от рекламодателей',
  forces: { push: [], pull: [], anxieties: [], habits: [] },
  desired_outcome: 'Согласие на интервью + договорённость о времени',
  non_goals: ['Продажа рекламы', 'Покупка размещения', 'Партнёрство'],
};

describe('goal_fit_evaluator', () => {
  it('returns continue on a goal-aligned exchange', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        score: 0.9,
        action: 'continue',
        reasons: ['interview confirmed', 'no non_goal mention'],
      }),
    });
    const ctx = makeCtx({ llm });
    const out = await goalFitEvaluator.run(
      {
        ajtbd: SAMPLE_AJTBD,
        history_tail: ['<< готов поговорить', '>> супер, когда удобно?'],
        intent: { intent: 'wants_to_schedule', confidence: 0.9 },
        handoff: { action: 'ai_continue', reason: 'all_clear' },
        draft: 'Давай вторник 15:00, скину ссылку.',
      },
      ctx,
    );
    expect(out.action).toBe('continue');
    expect(out.score).toBeGreaterThanOrEqual(0.85);
    expect(out.reasons.length).toBeGreaterThan(0);
    expect(llm._calls.completeJson).toBe(1);
  });

  it('returns soften on borderline drift', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        score: 0.65,
        action: 'soften',
        reasons: ['draft slightly pushy', 'no non_goal hit yet'],
      }),
    });
    const ctx = makeCtx({ llm });
    const out = await goalFitEvaluator.run(
      {
        ajtbd: SAMPLE_AJTBD,
        history_tail: ['<< расскажи зачем это', '>> хочу обсудить как можем выйти на сделку'],
        intent: { intent: 'needs_more_info', confidence: 0.6 },
        handoff: { action: 'ai_continue', reason: 'all_clear' },
        draft: 'Можем созвониться обсудить условия — это выгодно для тебя.',
      },
      ctx,
    );
    expect(out.action).toBe('soften');
    expect(out.score).toBeLessThan(0.75);
    expect(out.score).toBeGreaterThanOrEqual(0.6);
  });

  it('returns handoff_silent on a clear non_goal violation', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        score: 0.2,
        action: 'handoff_silent',
        reasons: ['contact asks about ad placement price', 'matches non_goal "Продажа рекламы"'],
      }),
    });
    const ctx = makeCtx({ llm });
    const out = await goalFitEvaluator.run(
      {
        ajtbd: SAMPLE_AJTBD,
        history_tail: ['<< сколько стоит размещение?'],
        intent: { intent: 'wants_payment_for_ads', confidence: 0.95 },
        handoff: { action: 'ai_continue', reason: 'no_hard_rule' },
        draft: 'Размещение стоит X — давайте обсудим.',
      },
      ctx,
    );
    expect(out.action).toBe('handoff_silent');
    expect(out.score).toBeLessThanOrEqual(0.3);
    expect(out.reasons.some((r) => r.toLowerCase().includes('non_goal'))).toBe(true);
  });

  it('rejects malformed LLM output via output schema validation', async () => {
    const llm = makeLLM({
      // Missing `action`, `score` out of range — should fail zod parse.
      completeJsonImpl: () => ({ score: 1.5, reasons: 'not-an-array' }),
    });
    const ctx = makeCtx({ llm });
    await expect(
      goalFitEvaluator.run(
        {
          ajtbd: SAMPLE_AJTBD,
          history_tail: [],
          intent: { intent: 'interested', confidence: 0.7 },
          handoff: { action: 'ai_continue', reason: 'ok' },
          draft: 'whatever',
        },
        ctx,
      ),
    ).rejects.toThrow();
  });

  it('caps history_tail to params.max_history_tail before invoking LLM', async () => {
    let receivedVarsLen = -1;
    const llm = makeLLM({
      completeJsonImpl: (req) => {
        // The user prompt template stringifies arrays; we read the rendered
        // user prompt and count how many history lines actually leaked
        // through. With cap=3, only the last 3 should appear.
        const text = ((req as { messages?: { content?: string }[] }).messages
          ?.map((m) => m.content ?? '')
          ?.join('\n') ?? '');
        receivedVarsLen =
          text.match(/<<|>>/g)?.length ?? 0; // direction markers in history
        return {
          score: 0.9,
          action: 'continue',
          reasons: ['ok'],
        };
      },
    });
    const ctx = makeCtx({
      llm,
      config: makeConfig({ params: { max_history_tail: 3 } }),
    });
    await goalFitEvaluator.run(
      {
        ajtbd: SAMPLE_AJTBD,
        history_tail: [
          '<< 1', '>> 2', '<< 3', '>> 4', '<< 5', '>> 6', '<< 7', '>> 8', '<< 9',
        ],
        intent: { intent: 'interested', confidence: 0.7 },
        handoff: { action: 'ai_continue', reason: 'ok' },
        draft: 'd',
      },
      ctx,
    );
    // We had 9 lines, cap is 3 — at most 3 markers should reach the prompt.
    expect(receivedVarsLen).toBeLessThanOrEqual(3);
  });
});
