import { describe, expect, it } from 'vitest';

import { bloggerDiscoveryReviewer } from '../agents/BloggerDiscoveryReviewer.js';
import { makeCtx, makeLLM } from './_mocks.js';

/**
 * BloggerDiscoveryReviewer (ajtbd-guided-blogger-discovery). LLM-driven; we
 * mock the LLM and assert the deterministic anti-fabrication guard: evidence is
 * grounded against supplied posts, fabricated citations are dropped, and a
 * candidate with no posts can never carry evidence.
 */
describe('bloggerDiscoveryReviewer', () => {
  const brief = 'B2B fintech founders';

  it('keeps evidence grounded by post id and verbatim snippet', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        score: 0.8,
        recommendation: 'strong_fit',
        rationale: 'on topic',
        risk_notes: [],
        evidence: [
          { post_id: 'p1', snippet: 'разбор финтех метрик для стартапов', why: 'topic match' },
          { post_id: null, snippet: 'как мы поднимали раунд', why: 'founder audience' },
        ],
      }),
    });
    const out = await bloggerDiscoveryReviewer.run(
      {
        brief,
        ajtbd: null,
        candidate: {
          platform: 'telegram',
          handle: 'fintech',
          title: 'Fintech',
          description: '',
          followers: 5000,
          language: 'ru',
          profile: null,
          recent_posts: [
            { id: 'p1', date: '2026-05-01', text: 'Сегодня разбор финтех метрик для стартапов и не только', urls: [] },
            { id: 'p2', date: '2026-05-02', text: 'Рассказываю как мы поднимали раунд в прошлом году', urls: [] },
          ],
        },
      },
      makeCtx({ llm }),
    );
    expect(out.recommendation).toBe('strong_fit');
    expect(out.evidence).toHaveLength(2);
    // post_id match re-attaches the real post date.
    expect(out.evidence[0]!.date).toBe('2026-05-01');
  });

  it('drops fabricated evidence not grounded in any supplied post', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        score: 0.7,
        recommendation: 'possible_fit',
        rationale: 'maybe',
        evidence: [
          { post_id: 'ghost', snippet: 'обзор премиум-яхт за миллион долларов', why: 'invented' },
        ],
      }),
    });
    const out = await bloggerDiscoveryReviewer.run(
      {
        brief,
        ajtbd: null,
        candidate: {
          platform: 'telegram',
          handle: 'x',
          title: '',
          description: '',
          followers: null,
          language: null,
          profile: null,
          recent_posts: [{ id: 'p1', date: null, text: 'обычный пост про финтех', urls: [] }],
        },
      },
      makeCtx({ llm }),
    );
    expect(out.evidence).toEqual([]);
  });

  it('forces empty evidence and an insufficient reason when no posts supplied', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        score: 0.4,
        recommendation: 'weak_fit',
        rationale: 'thin metadata only',
        evidence: [{ post_id: null, snippet: 'made up post', why: 'nope' }],
      }),
    });
    const out = await bloggerDiscoveryReviewer.run(
      {
        brief,
        ajtbd: null,
        candidate: {
          platform: 'telegram',
          handle: 'x',
          title: 'X',
          description: 'desc',
          followers: null,
          language: null,
          profile: null,
          recent_posts: [],
        },
      },
      makeCtx({ llm }),
    );
    expect(out.evidence).toEqual([]);
    expect(out.insufficient_evidence_reason).toBeTruthy();
  });
});
