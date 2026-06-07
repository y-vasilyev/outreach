// Env stubbing runs from vitest's setupFiles in apps/api/vitest.config.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------- Mocks for cross-package deps ------------------------------------
//
// matchingService reaches into Prisma (adBrief, bloggerProfile, matchResult)
// and the AgentRunner (the optional blogger_matcher re-rank). We stub both so
// we can assert: (a) the deterministic path issues NO LLM call, (b) re-rank is
// bounded to top N (N=10 with 50 candidates → at most 10 reach the agent),
// (c) match_result rows are persisted with the right rerankedByLlm flags.

interface PrismaMock {
  adBrief: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  bloggerProfile: { findMany: ReturnType<typeof vi.fn> };
  bloggerPostInsight: { findMany: ReturnType<typeof vi.fn> };
  matchResult: { deleteMany: ReturnType<typeof vi.fn>; createMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
}

const prismaMock: PrismaMock = {
  adBrief: { findUnique: vi.fn(), create: vi.fn() },
  bloggerProfile: { findMany: vi.fn() },
  bloggerPostInsight: { findMany: vi.fn() },
  matchResult: { deleteMany: vi.fn(), createMany: vi.fn() },
  $transaction: vi.fn(),
};

vi.mock('@nosquare/db', () => ({
  getPrisma: () => prismaMock,
}));

const runnerRun = vi.fn();
vi.mock('../agents.js', () => ({
  getAgentRunner: () => ({ run: runnerRun }),
}));

// Imported AFTER mocks so module wiring lands on the stubs.
import { matchingService } from '../matching.js';

const NOW = new Date('2026-05-20T00:00:00Z');

function briefRow(over: Record<string, unknown> = {}) {
  return {
    id: 'brief1',
    topic: 'крипта',
    audienceTarget: '',
    budget: null,
    formats: [],
    geo: [],
    deadline: null,
    notes: '',
    createdById: null,
    createdAt: NOW,
    ...over,
  };
}

function profileRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    channelId: `chan_${id}`,
    topics: ['крипта'],
    languages: ['ru'],
    formats: ['пост'],
    audience: { geo: { RU: 1 } },
    rateCards: [{ format: 'пост', price: 8000, currency: 'RUB' }],
    reach: 50000,
    avgViews: 10000,
    capturedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Capture-the-data $transaction: run each promise-returning op (they're the
  // mocked deleteMany/createMany calls already invoked by the service).
  prismaMock.$transaction.mockImplementation(async (ops: unknown[]) => ops);
  prismaMock.matchResult.deleteMany.mockReturnValue({ __op: 'deleteMany' });
  prismaMock.matchResult.createMany.mockImplementation((args: unknown) => ({ __op: 'createMany', args }));
  prismaMock.bloggerPostInsight.findMany.mockResolvedValue([]);
});

describe('matchingService.match — deterministic path (no LLM)', () => {
  it('returns ranked candidates and issues NO LLM call when rerank is off', async () => {
    prismaMock.adBrief.findUnique.mockResolvedValue(
      briefRow({ topic: 'крипта', budget: 20000, formats: ['пост'], geo: ['RU'] }),
    );
    prismaMock.bloggerProfile.findMany.mockResolvedValue([
      profileRow('a', { rateCards: [{ format: 'пост', price: 8000, currency: 'RUB' }] }),
      profileRow('b', { rateCards: [{ format: 'пост', price: 18000, currency: 'RUB' }] }),
      profileRow('off', { topics: ['кулинария'] }), // off-topic → excluded
    ]);

    const res = await matchingService.match('brief1', { rerank: false });

    expect(runnerRun).not.toHaveBeenCalled();
    // off-topic excluded by prefilter.
    expect(res.candidates.map((c) => c.profile.id).sort()).toEqual(['a', 'b']);
    // cheaper rate ranks first (budget-aware).
    expect(res.candidates[0]?.profile.id).toBe('a');
    expect(res.candidates.every((c) => c.rerankedByLlm === false)).toBe(true);

    // match_result rows persisted (deleteMany + createMany inside the tx).
    expect(prismaMock.matchResult.deleteMany).toHaveBeenCalledWith({ where: { briefId: 'brief1' } });
    expect(prismaMock.matchResult.createMany).toHaveBeenCalledTimes(1);
    const createArgs = prismaMock.matchResult.createMany.mock.calls[0]?.[0] as {
      data: { profileId: string; rerankedByLlm: boolean; fitSignals: unknown; evidencePostIds: string[] }[];
    };
    expect(createArgs.data).toHaveLength(2);
    expect(createArgs.data.every((d) => d.rerankedByLlm === false)).toBe(true);
    expect(createArgs.data.every((d) => Array.isArray(d.evidencePostIds))).toBe(true);
    expect(createArgs.data[0]!.fitSignals).toMatchObject({
      positiveSignals: expect.any(Array),
      gaps: expect.any(Array),
      scoreBreakdown: expect.objectContaining({ total: expect.any(Number) }),
    });
  });

  it('persists stored post evidence ids in fit metadata when post text matches the brief', async () => {
    prismaMock.adBrief.findUnique.mockResolvedValue(briefRow({ topic: 'крипта' }));
    prismaMock.bloggerProfile.findMany.mockResolvedValue([profileRow('a')]);
    prismaMock.bloggerPostInsight.findMany.mockResolvedValue([
      {
        id: 'post_evidence',
        profileId: 'a',
        channelId: 'chan_a',
        platform: 'telegram',
        externalPostId: '42',
        url: 'https://t.me/a/42',
        publishedAt: NOW,
        textSnippet: 'крипта и финансы',
        mediaKind: 'post',
        metrics: { views: 10000 },
        metricCapturedAt: NOW,
        source: 'telegram_public_parse',
        sourceRawRef: 'telegram:a:42',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);

    const res = await matchingService.match('brief1', { rerank: false });
    expect(res.candidates[0]!.fit?.evidencePostIds).toEqual(['post_evidence']);
    expect(res.candidates[0]!.profile.topPostsPreview?.[0]?.id).toBe('post_evidence');
    const createArgs = prismaMock.matchResult.createMany.mock.calls[0]?.[0] as {
      data: { evidencePostIds: string[] }[];
    };
    expect(createArgs.data[0]!.evidencePostIds).toEqual(['post_evidence']);
  });
});

describe('matchingService.match — bounded LLM re-rank', () => {
  it('sends at most the top N (N=10) of 50 candidates to the agent', async () => {
    prismaMock.adBrief.findUnique.mockResolvedValue(briefRow({ topic: 'крипта' }));
    // 50 qualifying profiles (all on-topic, no geo/format/budget constraint).
    const profiles = Array.from({ length: 50 }, (_, i) =>
      profileRow(`p${String(i).padStart(2, '0')}`, { reach: 1000 * (50 - i) }),
    );
    prismaMock.bloggerProfile.findMany.mockResolvedValue(profiles);

    // The agent echoes back exactly the candidates it received (re-ranked).
    let sentCount = 0;
    runnerRun.mockImplementation(async (_name: string, input: { candidates: { profile_id: string }[] }) => {
      sentCount = input.candidates.length;
      return {
        ranked: input.candidates.map((c, idx) => ({
          profile_id: c.profile_id,
          score: Math.max(0, 1 - idx * 0.01),
          rationale: `llm ${c.profile_id}`,
        })),
      };
    });

    const res = await matchingService.match('brief1', { rerank: true, topN: 10 });

    expect(runnerRun).toHaveBeenCalledTimes(1);
    // BOUNDED: at most N reach the agent.
    expect(sentCount).toBe(10);

    // Exactly the top-10 candidates are flagged rerankedByLlm; the tail keeps
    // deterministic order and rerankedByLlm=false.
    const reranked = res.candidates.filter((c) => c.rerankedByLlm);
    expect(reranked).toHaveLength(10);
    expect(res.candidates.filter((c) => !c.rerankedByLlm)).toHaveLength(40);
    // All 50 still returned.
    expect(res.candidates).toHaveLength(50);

    // Persisted flags mirror that split.
    const createArgs = prismaMock.matchResult.createMany.mock.calls[0]?.[0] as {
      data: { rerankedByLlm: boolean; evidencePostIds: string[]; fitSignals: unknown }[];
    };
    expect(createArgs.data.filter((d) => d.rerankedByLlm)).toHaveLength(10);
    expect(createArgs.data.every((d) => Array.isArray(d.evidencePostIds) && d.fitSignals)).toBe(true);
  });

  it('falls back to deterministic order if the re-rank agent throws', async () => {
    prismaMock.adBrief.findUnique.mockResolvedValue(briefRow({ topic: 'крипта' }));
    prismaMock.bloggerProfile.findMany.mockResolvedValue([profileRow('a'), profileRow('b')]);
    runnerRun.mockRejectedValue(new Error('llm down'));

    const res = await matchingService.match('brief1', { rerank: true });
    expect(res.candidates.length).toBe(2);
    expect(res.candidates.every((c) => c.rerankedByLlm === false)).toBe(true);
  });
});

describe('matchingService.createBrief / getBrief', () => {
  it('persists a brief with the creator id', async () => {
    prismaMock.adBrief.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'brief_new',
      ...data,
    }));
    const created = await matchingService.createBrief(
      { topic: 'крипта', audienceTarget: '', formats: [], geo: [], notes: '' },
      'user1',
    );
    expect(created.id).toBe('brief_new');
    expect(prismaMock.adBrief.create.mock.calls[0]?.[0].data.createdById).toBe('user1');
  });

  it('throws notFound for a missing brief', async () => {
    prismaMock.adBrief.findUnique.mockResolvedValue(null);
    await expect(matchingService.getBrief('nope')).rejects.toMatchObject({ statusCode: 404 });
  });
});
