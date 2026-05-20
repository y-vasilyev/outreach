import { describe, expect, it } from 'vitest';

import { dataCollectionPlanner } from '../agents/DataCollectionPlanner.js';
import { makeCtx, makeConfig, makeLLM } from './_mocks.js';

/**
 * DataCollectionPlanner (agency-sourcing-matching task 4.3/4.6): asks for the
 * next missing data point (never re-asking a collected one) and stops with a
 * goal-satisfied signal when all collected.
 */
describe('data_collection_planner', () => {
  const baseConfig = makeConfig({ systemPrompt: '', userPromptTemplate: '' });
  const TARGETS = ['rate_card', 'reach', 'audience_demographics', 'geo', 'deals_contact'];

  it('asks for a missing point and does not re-ask collected ones', async () => {
    let captured = '';
    const llm = makeLLM({
      completeJsonImpl: (req) => {
        captured = JSON.stringify(req);
        return {
          next_data_point: 'audience_demographics',
          reply: 'Спасибо за прайс! А какая у вас аудитория по полу и возрасту?',
          goal_satisfied: false,
          rationale: 'pricing collected, ask demographics',
        };
      },
    });
    const ctx = makeCtx({ llm, config: baseConfig });
    const out = await dataCollectionPlanner.run(
      {
        target_data_points: TARGETS,
        collected_data_points: ['rate_card'],
        history_tail: [],
        last_inbound: 'Прайс такой: пост 10к, сторис 3к.',
      },
      ctx,
    );
    expect(out.goal_satisfied).toBe(false);
    expect(out.next_data_point).toBe('audience_demographics');
    // The collected point must NOT be in the missing list fed to the LLM.
    expect(captured).not.toContain('"missing_data_points":["rate_card"');
    expect(captured).toContain('audience_demographics');
  });

  it('forces next_data_point to a genuinely-missing point if LLM picks a collected one', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        // LLM erroneously re-asks a collected point.
        next_data_point: 'rate_card',
        reply: 'Сколько стоит пост?',
        goal_satisfied: false,
        rationale: 'oops re-asking',
      }),
    });
    const ctx = makeCtx({ llm, config: baseConfig });
    const out = await dataCollectionPlanner.run(
      {
        target_data_points: TARGETS,
        collected_data_points: ['rate_card', 'reach'],
        history_tail: [],
        last_inbound: '',
      },
      ctx,
    );
    // rate_card is collected → planner overrides to the first missing one.
    expect(out.next_data_point).not.toBe('rate_card');
    expect(['audience_demographics', 'geo', 'deals_contact']).toContain(out.next_data_point);
    // The reply must NOT keep asking about the (collected) wrong point — the
    // planner substitutes a deterministic question for the corrected field.
    expect(out.reply).not.toMatch(/стоит пост/i);
    expect(out.reply).not.toMatch(/rate_card/i);
    expect(out.reply.length).toBeGreaterThan(0);
  });

  it('signals goal-satisfied with a closing reply when all collected', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        next_data_point: undefined,
        reply: 'Спасибо, всё собрал! Вернусь с конкретикой по клиенту.',
        goal_satisfied: true,
        rationale: 'done',
      }),
    });
    const ctx = makeCtx({ llm, config: baseConfig });
    const out = await dataCollectionPlanner.run(
      {
        target_data_points: TARGETS,
        collected_data_points: [...TARGETS],
        history_tail: [],
        last_inbound: '',
      },
      ctx,
    );
    expect(out.goal_satisfied).toBe(true);
    expect(out.next_data_point).toBeUndefined();
    expect(out.reply.length).toBeGreaterThan(0);
  });

  it('marks goal-satisfied even if the LLM falsely claims more is needed', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        next_data_point: 'reach',
        reply: 'А какие охваты?',
        goal_satisfied: false,
        rationale: 'wrong',
      }),
    });
    const ctx = makeCtx({ llm, config: baseConfig });
    const out = await dataCollectionPlanner.run(
      { target_data_points: TARGETS, collected_data_points: [...TARGETS], history_tail: [], last_inbound: '' },
      ctx,
    );
    // Deterministic truth: nothing missing → goal satisfied, no next point.
    expect(out.goal_satisfied).toBe(true);
    expect(out.next_data_point).toBeUndefined();
  });
});
