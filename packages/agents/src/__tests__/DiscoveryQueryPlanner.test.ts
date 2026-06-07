import { describe, expect, it } from 'vitest';

import { discoveryQueryPlanner } from '../agents/DiscoveryQueryPlanner.js';
import { makeCtx, makeLLM } from './_mocks.js';

/**
 * DiscoveryQueryPlanner (ajtbd-guided-blogger-discovery). LLM-driven; we mock
 * the LLM and assert the deterministic hardening: multi-query expansion,
 * site:/operator stripping, platform forcing on scoped runs, and dedupe.
 */
describe('discoveryQueryPlanner', () => {
  it('expands a niche into multiple platform-scoped queries', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        queries: [
          { query: 'финтех для основателей', platform: 'telegram', rationale: 'a', signal: 's1', confidence: 0.8 },
          { query: 'B2B финтех каналы', platform: 'telegram', rationale: 'b', signal: 's2', confidence: 0.7 },
          { query: 'финансы стартапов', platform: null, rationale: 'c', signal: 's3', confidence: 0.6 },
        ],
      }),
    });
    const out = await discoveryQueryPlanner.run(
      { brief: 'B2B fintech founders in Telegram', ajtbd: null, platform: null, geo: [], language: 'ru', max_queries: 8 },
      makeCtx({ llm }),
    );
    expect(out.queries).toHaveLength(3);
    expect(out.queries.map((q) => q.query)).toContain('B2B финтех каналы');
  });

  it('strips leaked site:/operators from query text', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        queries: [
          { query: 'site:t.me финтех каналы', platform: 'telegram', confidence: 0.8 },
        ],
      }),
    });
    const out = await discoveryQueryPlanner.run(
      { brief: 'fintech', ajtbd: null, platform: null, geo: [], language: null, max_queries: 8 },
      makeCtx({ llm }),
    );
    expect(out.queries[0]!.query).toBe('финтех каналы');
  });

  it('forces the run platform onto every query when scoped', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        queries: [
          { query: 'кулинария рецепты', platform: 'youtube', confidence: 0.8 },
          { query: 'домашние десерты', platform: null, confidence: 0.7 },
        ],
      }),
    });
    const out = await discoveryQueryPlanner.run(
      { brief: 'cooking', ajtbd: null, platform: 'telegram', geo: [], language: null, max_queries: 8 },
      makeCtx({ llm }),
    );
    expect(out.queries.every((q) => q.platform === 'telegram')).toBe(true);
  });

  it('de-dupes queries by platform + normalized text', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        queries: [
          { query: 'финтех каналы', platform: 'telegram', confidence: 0.8 },
          { query: 'Финтех Каналы', platform: 'telegram', confidence: 0.7 },
        ],
      }),
    });
    const out = await discoveryQueryPlanner.run(
      { brief: 'fintech', ajtbd: null, platform: null, geo: [], language: null, max_queries: 8 },
      makeCtx({ llm }),
    );
    expect(out.queries).toHaveLength(1);
  });
});
