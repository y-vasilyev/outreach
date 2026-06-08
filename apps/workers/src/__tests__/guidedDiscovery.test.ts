import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Guided discovery worker (ajtbd-guided-blogger-discovery, task 4.7).
 *
 * Covers: a successful end-to-end run, planner failure (no search attempted),
 * partial search failure isolation, a pending-scrape candidate (no fabricated
 * evidence), reviewer output persistence, and review-budget truncation.
 * Yandex search core, agent runner, queue, and prisma are all mocked.
 */

const SNAPSHOT = {
  campaignId: null,
  brief: 'B2B fintech founders',
  ajtbd: null,
  platform: null,
  geo: [],
  language: null,
  budgets: { maxQueries: 8, maxResultsPerQuery: 20, maxCandidates: 40, maxReviewed: 15 },
};

const mocks = vi.hoisted(() => {
  const prisma = {
    discoveryRun: {
      findUnique: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => ({})),
    },
    discoveryRunCandidate: {
      upsert: vi.fn(),
      update: vi.fn(async () => ({})),
    },
    integration: { findUnique: vi.fn() },
    channel: { findUnique: vi.fn(), create: vi.fn() },
    bloggerProfile: { findFirst: vi.fn(async () => null) },
  };
  const scrapeAdd = vi.fn(async () => ({}));
  const decrypt = vi.fn(async () => ({ apiKey: 'k', folderId: 'f' }));
  const execSearch = vi.fn();
  const run = vi.fn();
  return { prisma, scrapeAdd, decrypt, execSearch, run };
});

vi.mock('@nosquare/db', () => ({ getPrisma: () => mocks.prisma, decryptJson: mocks.decrypt }));
vi.mock('@nosquare/platforms', () => ({
  YandexSearchClient: class {},
  executePlannedSearches: (...args: unknown[]) => mocks.execSearch(...args),
}));
vi.mock('bullmq', () => {
  class Queue {
    add = mocks.scrapeAdd;
  }
  class Worker {}
  return { Queue, Worker };
});
vi.mock('../redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../services/runner.js', () => ({ getRunner: () => ({ run: mocks.run }) }));

import { __internal } from '../queues/guided-discovery.js';

const { handleGuidedDiscovery } = __internal;

/** Pull the latest discoveryRun.update payload for status/summary assertions. */
function lastRunUpdate(): { status?: string; summary?: Record<string, unknown> } {
  const calls = mocks.prisma.discoveryRun.update.mock.calls as unknown as Array<
    [{ data: { status?: string; summary?: Record<string, unknown> } }]
  >;
  const last = calls[calls.length - 1]?.[0];
  return last?.data ?? {};
}

/** Find a discoveryRunCandidate.update whose data matches the predicate. */
function candidateUpdateCalls(): Array<{ data: Record<string, unknown> }> {
  return (mocks.prisma.discoveryRunCandidate.update.mock.calls as unknown as Array<
    [{ data: Record<string, unknown> }]
  >).map((c) => c[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.discoveryRun.findUnique.mockResolvedValue({
    id: 'run_1',
    status: 'pending',
    createdById: 'u1',
    input: SNAPSHOT,
    summary: {},
    trace: [],
  });
  mocks.prisma.discoveryRun.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.integration.findUnique.mockResolvedValue({
    kind: 'yandex_search',
    enabled: true,
    configEncrypted: 'enc',
  });
  mocks.decrypt.mockResolvedValue({ apiKey: 'k', folderId: 'f' });
  mocks.prisma.bloggerProfile.findFirst.mockResolvedValue(null);
  let candSeq = 0;
  mocks.prisma.discoveryRunCandidate.upsert.mockImplementation(async () => ({ id: `cand_${++candSeq}` }));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('handleGuidedDiscovery', () => {
  it('runs end-to-end: plan → search → enrich → review → done', async () => {
    mocks.run.mockImplementation(async (name: string) => {
      if (name === 'discovery_query_planner') {
        return { queries: [{ query: 'финтех основатели', platform: 'telegram', confidence: 0.8 }] };
      }
      return {
        score: 0.85,
        recommendation: 'strong_fit',
        rationale: 'on topic',
        risk_notes: [],
        evidence: [{ post_id: 'p1', date: '2026-05-01', snippet: 'финтех', urls: [], why: 'match' }],
        insufficient_evidence_reason: null,
      };
    });
    mocks.execSearch.mockResolvedValue({
      candidates: [
        { platform: 'telegram', handle: 'fintech_known', url: 'https://t.me/fintech_known', title: 'K', sourceQuery: 'финтех основатели', sourceQueries: ['финтех основатели'] },
      ],
      trace: [{ query: 'финтех основатели', platform: 'telegram', status: 'ok', resultCount: 3, candidateCount: 1, startedAt: '', completedAt: '' }],
    });
    // Existing (known) channel WITH scraped data.
    mocks.prisma.channel.findUnique.mockImplementation(async ({ where }: { where: { id?: string; platform_handle?: { handle: string } } }) => {
      if (where.id) {
        return { id: 'ch_known', status: 'scraped', title: 'Fintech', description: 'about', followers: 5000, language: 'ru', rawData: { posts: [{ id: 'p1', date: '2026-05-01', text: 'про финтех', urls: [] }] } };
      }
      return { id: 'ch_known' }; // existence check → known
    });

    await handleGuidedDiscovery({ runId: 'run_1' });

    expect(mocks.execSearch).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.discoveryRunCandidate.upsert).toHaveBeenCalledTimes(1);
    // reviewer ran and persisted the score/recommendation.
    const reviewUpdate = candidateUpdateCalls().find((c) => c.data.recommendation);
    expect(reviewUpdate).toBeDefined();
    const data = lastRunUpdate();
    expect(data.status).toBe('done');
    expect(data.summary?.recommended).toBe(1);
    expect(data.summary?.candidatesReviewed).toBe(1);
  });

  it('fails the run when the planner returns no queries and never searches', async () => {
    mocks.run.mockImplementation(async (name: string) => {
      if (name === 'discovery_query_planner') return { queries: [] };
      return {};
    });

    await handleGuidedDiscovery({ runId: 'run_1' });

    expect(mocks.execSearch).not.toHaveBeenCalled();
    const data = lastRunUpdate();
    expect(data.status).toBe('failed');
    expect(String(data.summary?.fatalError)).toContain('no usable queries');
  });

  it('isolates a partial search failure and still completes', async () => {
    mocks.run.mockImplementation(async (name: string) => {
      if (name === 'discovery_query_planner') {
        return { queries: [{ query: 'aa', platform: 'telegram' }, { query: 'bb', platform: 'telegram' }] };
      }
      return { score: 0.6, recommendation: 'possible_fit', rationale: '', risk_notes: [], evidence: [], insufficient_evidence_reason: 'thin' };
    });
    mocks.execSearch.mockResolvedValue({
      candidates: [
        { platform: 'telegram', handle: 'okchan', url: 'https://t.me/okchan', title: '', sourceQuery: 'b', sourceQueries: ['b'] },
      ],
      trace: [
        { query: 'a', platform: 'telegram', status: 'error', resultCount: 0, candidateCount: 0, error: 'Yandex 503', startedAt: '', completedAt: '' },
        { query: 'b', platform: 'telegram', status: 'ok', resultCount: 2, candidateCount: 1, startedAt: '', completedAt: '' },
      ],
    });
    mocks.prisma.channel.findUnique.mockImplementation(async ({ where }: { where: { id?: string; platform_handle?: unknown } }) => {
      if (where.id) return { id: 'ch_ok', status: 'scraped', title: 'Ok', description: 'd', followers: 100, language: 'ru', rawData: { posts: [] } };
      return { id: 'ch_ok' };
    });

    await handleGuidedDiscovery({ runId: 'run_1' });
    const data = lastRunUpdate();
    expect(data.status).toBe('done');
    expect(data.summary?.failedQueries).toBe(1);
    expect(data.summary?.executedQueries).toBe(1);
  });

  it('leaves a brand-new candidate pending → run enriching, never reviews it inline', async () => {
    mocks.run.mockImplementation(async (name: string) => {
      if (name === 'discovery_query_planner') return { queries: [{ query: 'xx', platform: 'telegram' }] };
      throw new Error('reviewer should not be called for un-scraped candidate');
    });
    mocks.execSearch.mockResolvedValue({
      candidates: [
        { platform: 'telegram', handle: 'brand_new', url: 'https://t.me/brand_new', title: '', sourceQuery: 'x', sourceQueries: ['x'] },
      ],
      trace: [{ query: 'x', platform: 'telegram', status: 'ok', resultCount: 1, candidateCount: 1, startedAt: '', completedAt: '' }],
    });
    // New channel: existence check → null, create → id, by-id load → status 'new', no data.
    mocks.prisma.channel.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => {
      if (where.id) return { id: 'ch_new', status: 'new', title: null, description: null, followers: null, language: null, rawData: null };
      return null;
    });
    mocks.prisma.channel.create.mockResolvedValue({ id: 'ch_new' });

    await handleGuidedDiscovery({ runId: 'run_1' });

    // Scrape enqueued with attempts:1 (D3 final-failure hook fires promptly).
    expect(mocks.scrapeAdd).toHaveBeenCalledWith('scrape', { channelId: 'ch_new' }, { attempts: 1 });
    const needsScrape = candidateUpdateCalls().find(
      (c) => c.data.enrichmentStatus === 'needs_scrape',
    );
    expect(needsScrape).toBeDefined();
    // BUG #1 fix: the run is NOT done — it is enriching with a pendingReview
    // count, and a bounded sweep job is enqueued.
    const data = lastRunUpdate();
    expect(data.status).toBe('enriching');
    expect(data.summary?.candidatesReviewed).toBe(0);
    expect(data.summary?.pendingReview).toBe(1);
    expect(mocks.scrapeAdd).toHaveBeenCalledWith(
      'sweep',
      { runId: 'run_1', sweep: true },
      expect.objectContaining({ jobId: 'sweep:discovery:run_1', attempts: 1 }),
    );
  });

  it('truncates the review budget and records skipped candidates', async () => {
    mocks.prisma.discoveryRun.findUnique.mockResolvedValue({
      id: 'run_1',
      status: 'pending',
      createdById: 'u1',
      input: { ...SNAPSHOT, budgets: { ...SNAPSHOT.budgets, maxReviewed: 1 } },
      summary: {},
      trace: [],
    });
    mocks.run.mockImplementation(async (name: string) => {
      if (name === 'discovery_query_planner') return { queries: [{ query: 'qq', platform: 'telegram' }] };
      return { score: 0.8, recommendation: 'strong_fit', rationale: '', risk_notes: [], evidence: [], insufficient_evidence_reason: null };
    });
    mocks.execSearch.mockResolvedValue({
      candidates: [
        { platform: 'telegram', handle: 'one', url: 'https://t.me/one', title: '', sourceQuery: 'q', sourceQueries: ['q'] },
        { platform: 'telegram', handle: 'two', url: 'https://t.me/two', title: '', sourceQuery: 'q', sourceQueries: ['q'] },
      ],
      trace: [{ query: 'q', platform: 'telegram', status: 'ok', resultCount: 2, candidateCount: 2, startedAt: '', completedAt: '' }],
    });
    mocks.prisma.channel.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => {
      if (where.id) return { id: 'ch_x', status: 'scraped', title: 'T', description: 'd', followers: 1, language: 'ru', rawData: { posts: [] } };
      return { id: 'ch_x' };
    });

    await handleGuidedDiscovery({ runId: 'run_1' });
    const data = lastRunUpdate();
    expect(data.summary?.candidatesReviewed).toBe(1);
    expect(data.summary?.candidatesSkipped).toBe(1);
  });

  it('skips a terminal run', async () => {
    mocks.prisma.discoveryRun.findUnique.mockResolvedValue({ id: 'run_1', status: 'done' });
    await handleGuidedDiscovery({ runId: 'run_1' });
    expect(mocks.prisma.discoveryRun.updateMany).not.toHaveBeenCalled();
    expect(mocks.execSearch).not.toHaveBeenCalled();
  });
});
