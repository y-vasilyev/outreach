import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Guided-discovery per-candidate review worker
 * (fix-guided-discovery-evidence-loop, D4/D5). Covers: review with evidence
 * persists score/recommendation; scrape-failed → terminal insufficient-evidence
 * with NO LLM call; the atomic claim makes a duplicate job a no-op (no LLM);
 * the completion check flips `enriching → done` only when the last candidate
 * closes; a re-armed (`pending_enrichment`) already-reviewed candidate is
 * re-scored; sweep force-closes a wedged run; budget respected.
 */

const SNAPSHOT = {
  campaignId: null,
  brief: 'B2B fintech',
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
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    discoveryRunCandidate: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(),
      findMany: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
      update: vi.fn(async () => ({})),
    },
    channel: { findUnique: vi.fn() },
    bloggerProfile: { findFirst: vi.fn(async () => null) },
  };
  const run = vi.fn();
  return { prisma, run };
});

vi.mock('@nosquare/db', () => ({
  getPrisma: () => mocks.prisma,
  Prisma: { JsonNull: null, DbNull: '__DB_NULL__', AnyNull: '__ANY_NULL__' },
}));
vi.mock('bullmq', () => {
  class Queue {
    add = vi.fn(async () => ({}));
  }
  class Worker {
    on = vi.fn();
  }
  return { Queue, Worker };
});
vi.mock('../redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../services/runner.js', () => ({ getRunner: () => ({ run: mocks.run }) }));

import { __internal } from '../queues/guided-discovery-review.js';

const { handleReview } = __internal;

function lastCandUpdate(): Record<string, unknown> | undefined {
  const calls = mocks.prisma.discoveryRunCandidate.update.mock.calls as unknown as Array<
    [{ data: Record<string, unknown> }]
  >;
  return calls[calls.length - 1]?.[0]?.data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.discoveryRun.findUnique.mockResolvedValue({
    id: 'run_1',
    status: 'enriching',
    input: SNAPSHOT,
    summary: { budgets: SNAPSHOT.budgets },
    trace: [],
  });
  mocks.prisma.discoveryRunCandidate.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.discoveryRunCandidate.findMany.mockResolvedValue([]);
  mocks.prisma.discoveryRun.updateMany.mockResolvedValue({ count: 1 });
});

describe('guided-discovery-review', () => {
  it('reviews a candidate with evidence and persists score/recommendation', async () => {
    mocks.prisma.discoveryRunCandidate.findUnique.mockResolvedValue({
      id: 'c1', runId: 'run_1', channelId: 'ch1', platform: 'telegram', handle: 'h', enrichmentStatus: 'needs_scrape', review: null,
    });
    mocks.prisma.channel.findUnique.mockResolvedValue({
      id: 'ch1', status: 'scraped', title: 'T', description: 'd', followers: 1, language: 'ru', rawData: { posts: [{ id: 'p1', text: 'x', urls: [] }] },
    });
    // completion check: this candidate now reviewed → 0 pending.
    mocks.prisma.discoveryRunCandidate.findMany.mockResolvedValue([{ review: { rationale: 'ok' } }]);
    mocks.run.mockResolvedValue({
      score: 0.9, recommendation: 'strong_fit', rationale: 'on topic', risk_notes: [], evidence: [], insufficient_evidence_reason: null,
    });

    await handleReview({ runId: 'run_1', candidateId: 'c1', scrapeOutcome: 'ok' });

    expect(mocks.run).toHaveBeenCalledTimes(1);
    const data = lastCandUpdate();
    expect(data?.recommendation).toBe('strong_fit');
    expect(data?.enrichmentStatus).toBe('enriched');
    // completion flips enriching → done.
    expect(mocks.prisma.discoveryRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'run_1', status: 'enriching' }, data: expect.objectContaining({ status: 'done' }) }),
    );
  });

  it('scrapeOutcome=failed → terminal insufficient-evidence, no LLM call', async () => {
    mocks.prisma.discoveryRunCandidate.findUnique.mockResolvedValue({
      id: 'c1', runId: 'run_1', channelId: 'ch1', platform: 'telegram', handle: 'h', enrichmentStatus: 'needs_scrape', review: null,
    });
    mocks.prisma.channel.findUnique.mockResolvedValue({ id: 'ch1', status: 'failed', title: null, description: null, rawData: null });
    mocks.prisma.discoveryRunCandidate.findMany.mockResolvedValue([{ review: { noLlm: true } }]);

    await handleReview({ runId: 'run_1', candidateId: 'c1', scrapeOutcome: 'failed' });

    expect(mocks.run).not.toHaveBeenCalled();
    const data = lastCandUpdate();
    expect((data?.review as { insufficientEvidenceReason?: string }).insufficientEvidenceReason).toContain('scrape failed');
  });

  it('atomic claim: a duplicate job is a no-op with no LLM call', async () => {
    mocks.prisma.discoveryRunCandidate.updateMany.mockResolvedValue({ count: 0 });

    await handleReview({ runId: 'run_1', candidateId: 'c1', scrapeOutcome: 'ok' });

    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.prisma.discoveryRunCandidate.findUnique).not.toHaveBeenCalled();
  });

  it('already-reviewed and not re-armed → no-op', async () => {
    mocks.prisma.discoveryRunCandidate.findUnique.mockResolvedValue({
      id: 'c1', runId: 'run_1', channelId: 'ch1', platform: 'telegram', handle: 'h', enrichmentStatus: 'enriched', review: { rationale: 'done' },
    });

    await handleReview({ runId: 'run_1', candidateId: 'c1', scrapeOutcome: 'ok' });

    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('re-armed (pending_enrichment) already-reviewed candidate is re-scored', async () => {
    mocks.prisma.discoveryRunCandidate.findUnique.mockResolvedValue({
      id: 'c1', runId: 'run_1', channelId: 'ch1', platform: 'telegram', handle: 'h', enrichmentStatus: 'pending_enrichment', review: { rationale: 'stale' },
    });
    mocks.prisma.channel.findUnique.mockResolvedValue({
      id: 'ch1', status: 'scraped', title: 'T', description: 'd', rawData: { posts: [{ id: 'p1', text: 'x', urls: [] }] },
    });
    mocks.prisma.discoveryRunCandidate.findMany.mockResolvedValue([{ review: { rationale: 'new' } }]);
    mocks.run.mockResolvedValue({ score: 0.5, recommendation: 'possible_fit', rationale: 'fresh', risk_notes: [], evidence: [], insufficient_evidence_reason: null });

    await handleReview({ runId: 'run_1', candidateId: 'c1', scrapeOutcome: 'ok' });

    // stale review cleared first, then reviewer called.
    expect(mocks.run).toHaveBeenCalledTimes(1);
    const clearCall = (mocks.prisma.discoveryRunCandidate.update.mock.calls as unknown as Array<[{ data: Record<string, unknown> }]>)
      .find((c) => c[0].data.review === null && c[0].data.score === null);
    expect(clearCall).toBeDefined();
  });

  it('does not flip to done while a candidate is still pending', async () => {
    mocks.prisma.discoveryRunCandidate.findUnique.mockResolvedValue({
      id: 'c1', runId: 'run_1', channelId: 'ch1', platform: 'telegram', handle: 'h', enrichmentStatus: 'needs_scrape', review: null,
    });
    mocks.prisma.channel.findUnique.mockResolvedValue({ id: 'ch1', status: 'scraped', title: 'T', rawData: { posts: [{ id: 'p', text: 'x', urls: [] }] } });
    // One reviewed, one still pending (review null).
    mocks.prisma.discoveryRunCandidate.findMany.mockResolvedValue([{ review: { rationale: 'ok' } }, { review: null }]);
    mocks.run.mockResolvedValue({ score: 0.8, recommendation: 'strong_fit', rationale: '', risk_notes: [], evidence: [], insufficient_evidence_reason: null });

    await handleReview({ runId: 'run_1', candidateId: 'c1', scrapeOutcome: 'ok' });

    expect(mocks.prisma.discoveryRun.updateMany).not.toHaveBeenCalled();
  });

  it('does NOT flip to done when a re-armed candidate has a stale review (BUG #4)', async () => {
    mocks.prisma.discoveryRunCandidate.findUnique.mockResolvedValue({
      id: 'c1', runId: 'run_1', channelId: 'ch1', platform: 'telegram', handle: 'h', enrichmentStatus: 'needs_scrape', review: null,
    });
    mocks.prisma.channel.findUnique.mockResolvedValue({ id: 'ch1', status: 'scraped', title: 'T', rawData: { posts: [{ id: 'p', text: 'x', urls: [] }] } });
    // Completion recompute: this candidate now reviewed, but a SECOND candidate
    // was re-armed by scrape_refresh — it carries a STALE non-null review while
    // enrichmentStatus='pending_enrichment'. It must still count as pending so
    // the run stays open until its re-review job runs.
    mocks.prisma.discoveryRunCandidate.findMany.mockResolvedValue([
      { review: { rationale: 'ok' }, enrichmentStatus: 'enriched' },
      { review: { rationale: 'stale' }, enrichmentStatus: 'pending_enrichment' },
    ]);
    mocks.run.mockResolvedValue({ score: 0.8, recommendation: 'strong_fit', rationale: '', risk_notes: [], evidence: [], insufficient_evidence_reason: null });

    await handleReview({ runId: 'run_1', candidateId: 'c1', scrapeOutcome: 'ok' });

    expect(mocks.prisma.discoveryRun.updateMany).not.toHaveBeenCalled();
  });

  it('sweep forces terminal outcomes and completes a wedged run', async () => {
    mocks.prisma.discoveryRunCandidate.findMany
      .mockResolvedValueOnce([{ id: 'c1', handle: 'h', review: null }]) // open candidates
      .mockResolvedValueOnce([{ review: { noLlm: true } }]); // completion recompute → 0 pending

    await handleReview({ runId: 'run_1', sweep: true });

    const data = lastCandUpdate();
    expect((data?.review as { insufficientEvidenceReason?: string }).insufficientEvidenceReason).toContain('did not complete in time');
    expect(mocks.prisma.discoveryRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'run_1', status: 'enriching' } }),
    );
  });

  it('respects maxReviewed budget across hook reviews', async () => {
    mocks.prisma.discoveryRun.findUnique.mockResolvedValue({
      id: 'run_1', status: 'enriching', input: { ...SNAPSHOT, budgets: { ...SNAPSHOT.budgets, maxReviewed: 1 } }, summary: { budgets: SNAPSHOT.budgets }, trace: [],
    });
    mocks.prisma.discoveryRunCandidate.findUnique.mockResolvedValue({
      id: 'c2', runId: 'run_1', channelId: 'ch2', platform: 'telegram', handle: 'h2', enrichmentStatus: 'needs_scrape', review: null,
    });
    // budget recompute: one already-reviewed candidate (c1) already at budget.
    mocks.prisma.discoveryRunCandidate.findMany.mockResolvedValue([
      { id: 'c1', review: { rationale: 'already reviewed' } },
      { id: 'c2', review: null },
    ]);

    await handleReview({ runId: 'run_1', candidateId: 'c2', scrapeOutcome: 'ok' });

    expect(mocks.run).not.toHaveBeenCalled();
    const data = lastCandUpdate();
    expect(data?.review).toEqual({ skipped: 'budget' });
  });

  it('no-ops a terminal run', async () => {
    mocks.prisma.discoveryRun.findUnique.mockResolvedValue({ id: 'run_1', status: 'done' });
    await handleReview({ runId: 'run_1', candidateId: 'c1', scrapeOutcome: 'ok' });
    expect(mocks.prisma.discoveryRunCandidate.updateMany).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
