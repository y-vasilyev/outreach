import { describe, expect, it } from 'vitest';

import { bloggerMatcher, type BloggerMatcherInput } from '../agents/BloggerMatcher.js';
import { makeCtx, makeConfig, makeLLM } from './_mocks.js';

/**
 * BloggerMatcher (agency-sourcing-matching M7, task 7.4/7.6).
 *
 * The agent is an OPTIONAL re-rank: with `enable_llm_rerank` off it must issue
 * NO LLM call and keep the input order; with it on it re-ranks only the
 * candidates it was given (the caller bounds the slice to top N).
 */
function brief(): BloggerMatcherInput['brief'] {
  return {
    topic: 'крипта',
    audience_target: 'инвесторы',
    budget: 20000,
    formats: ['пост'],
    geo: ['RU'],
    notes: '',
  };
}

function candidate(id: string, score: number) {
  return {
    profile_id: id,
    score,
    rationale: `det ${id}`,
    topics: ['крипта'],
    languages: ['ru'],
    formats: ['пост'],
    geo: ['RU'],
    rate_cards: [{ format: 'пост', price: 10000, currency: 'RUB' }],
    reach: 50000,
  };
}

describe('blogger_matcher', () => {
  it('issues NO LLM call and preserves order when re-rank is disabled', async () => {
    const llm = makeLLM();
    const config = makeConfig({ params: { enable_llm_rerank: false } });
    const ctx = makeCtx({ llm, config });
    const out = await bloggerMatcher.run(
      { brief: brief(), candidates: [candidate('a', 0.9), candidate('b', 0.7)] },
      ctx,
    );
    expect(llm._calls.completeJson).toBe(0);
    expect(llm._calls.complete).toBe(0);
    expect(out.ranked.map((r) => r.profile_id)).toEqual(['a', 'b']);
  });

  it('re-ranks the given candidates when enabled (LLM reorders)', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        ranked: [
          { profile_id: 'b', score: 0.95, rationale: 'лучший фит по нюансам' },
          { profile_id: 'a', score: 0.6, rationale: 'дороже' },
        ],
      }),
    });
    const config = makeConfig({ params: { enable_llm_rerank: true } });
    const ctx = makeCtx({ llm, config });
    const out = await bloggerMatcher.run(
      { brief: brief(), candidates: [candidate('a', 0.9), candidate('b', 0.7)] },
      ctx,
    );
    expect(llm._calls.completeJson).toBe(1);
    expect(out.ranked.map((r) => r.profile_id)).toEqual(['b', 'a']);
    expect(out.ranked[0]?.rationale).toContain('нюанс');
  });

  it('drops invented ids and re-attaches deterministic scores for omitted ones', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        ranked: [
          { profile_id: 'ghost', score: 0.99, rationale: 'invented' },
          { profile_id: 'a', score: 0.8, rationale: 'kept' },
        ],
      }),
    });
    const config = makeConfig({ params: { enable_llm_rerank: true } });
    const ctx = makeCtx({ llm, config });
    const out = await bloggerMatcher.run(
      { brief: brief(), candidates: [candidate('a', 0.9), candidate('b', 0.7)] },
      ctx,
    );
    const ids = out.ranked.map((r) => r.profile_id).sort();
    expect(ids).toEqual(['a', 'b']); // no ghost, b re-attached
    // b kept its deterministic score/rationale.
    expect(out.ranked.find((r) => r.profile_id === 'b')?.rationale).toBe('det b');
  });
});
