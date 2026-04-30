import { describe, expect, it } from 'vitest';

import { handoffDecider } from '../agents/HandoffDecider.js';
import { makeCtx, makeConfig, makeLLM } from './_mocks.js';

describe('handoff_decider — deterministic rules', () => {
  it('escalates immediately on hostile intent without calling LLM', async () => {
    const llm = makeLLM();
    const ctx = makeCtx({ llm });
    const out = await handoffDecider.run(
      {
        conversation: { mode: 'auto', history_tail: [] },
        intent: { intent: 'hostile', confidence: 0.9 },
        ai_recent_confidence: [],
        red_flags_total: 0,
      },
      ctx,
    );
    expect(out.action).toBe('operator_now');
    expect(out.urgency).toBe('high');
    expect(out.reason).toContain('hostile');
    expect(llm._calls.completeJson).toBe(0);
  });

  it('escalates on wants_payment_for_ads', async () => {
    const llm = makeLLM();
    const ctx = makeCtx({ llm });
    const out = await handoffDecider.run(
      {
        conversation: { mode: 'auto', history_tail: [] },
        intent: { intent: 'wants_payment_for_ads', confidence: 0.95 },
        ai_recent_confidence: [],
        red_flags_total: 0,
      },
      ctx,
    );
    expect(out.action).toBe('operator_now');
    expect(llm._calls.completeJson).toBe(0);
  });

  it('escalates on request_human and on wants_to_schedule', async () => {
    const llm = makeLLM();
    const ctx = makeCtx({ llm });
    for (const intent of ['request_human', 'wants_to_schedule'] as const) {
      const out = await handoffDecider.run(
        {
          conversation: { mode: 'auto', history_tail: [] },
          intent: { intent, confidence: 0.8 },
          ai_recent_confidence: [],
          red_flags_total: 0,
        },
        ctx,
      );
      expect(out.action).toBe('operator_now');
    }
    expect(llm._calls.completeJson).toBe(0);
  });

  it('demotes to ai_suggest_only after 2 consecutive low confidences', async () => {
    const llm = makeLLM();
    const ctx = makeCtx({
      llm,
      config: makeConfig({ params: { confidence_threshold: 0.5 } }),
    });
    const out = await handoffDecider.run(
      {
        conversation: { mode: 'auto', history_tail: [] },
        intent: { intent: 'interested', confidence: 0.7 },
        ai_recent_confidence: [0.3, 0.4],
        red_flags_total: 0,
      },
      ctx,
    );
    expect(out.action).toBe('ai_suggest_only');
    expect(llm._calls.completeJson).toBe(0);
  });

  it('escalates on configured escalation_keywords', async () => {
    const llm = makeLLM();
    const ctx = makeCtx({
      llm,
      config: makeConfig({ params: { escalation_keywords: ['жалоба'] } }),
    });
    const out = await handoffDecider.run(
      {
        conversation: {
          mode: 'auto',
          last_inbound: 'Это жалоба на спам',
          history_tail: [],
        },
        intent: { intent: 'interested', confidence: 0.9 },
        ai_recent_confidence: [],
        red_flags_total: 0,
      },
      ctx,
    );
    expect(out.action).toBe('operator_now');
    expect(out.reason).toContain('escalation_keyword');
    expect(llm._calls.completeJson).toBe(0);
  });

  it('falls through to LLM when no rule fires', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        action: 'ai_continue',
        reason: 'all_clear',
        urgency: 'low',
      }),
    });
    const ctx = makeCtx({ llm });
    const out = await handoffDecider.run(
      {
        conversation: { mode: 'auto', history_tail: [] },
        intent: { intent: 'interested', confidence: 0.85 },
        ai_recent_confidence: [0.8, 0.9],
        red_flags_total: 0,
      },
      ctx,
    );
    expect(out.action).toBe('ai_continue');
    expect(llm._calls.completeJson).toBe(1);
  });
});
