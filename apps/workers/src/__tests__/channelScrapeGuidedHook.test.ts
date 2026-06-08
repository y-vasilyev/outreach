import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * channel-scrape → guided-discovery review hook
 * (fix-guided-discovery-evidence-loop, D3). Verifies the success and
 * final-failure hooks enqueue a review job per open discovery candidate of the
 * scraped channel, with a deterministic jobId (scrape-generation aware) and
 * `attempts: 1`, and that the selector matches re-armed
 * (`enrichmentStatus='pending_enrichment'`) candidates with a non-null review.
 */

const mocks = vi.hoisted(() => {
  const prisma = {
    discoveryRunCandidate: { findMany: vi.fn(async (_args: unknown): Promise<Array<Record<string, unknown>>> => []) },
  };
  const reviewAdd = vi.fn(async () => ({}));
  return { prisma, reviewAdd };
});

// AnyNull is a distinct sentinel from JsonNull so the test proves the selector
// uses AnyNull (matches both SQL NULL and JSON null), not JsonNull (BUG #1).
vi.mock('@nosquare/db', () => ({
  getPrisma: () => mocks.prisma,
  Prisma: { JsonNull: '__JSON_NULL__', DbNull: '__DB_NULL__', AnyNull: '__ANY_NULL__' },
}));
vi.mock('bullmq', () => {
  class Queue {
    add = mocks.reviewAdd;
  }
  class Worker {
    on = vi.fn();
  }
  return { Queue, Worker };
});
vi.mock('../redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { __testHook } from '../queues/channel-scrape.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('triggerGuidedReview', () => {
  it('enqueues a review job per open candidate on scrape success', async () => {
    mocks.prisma.discoveryRunCandidate.findMany.mockResolvedValue([
      { id: 'c1', runId: 'r1', provenance: { scrapeGeneration: 2 } },
      { id: 'c2', runId: 'r1', provenance: {} },
    ]);

    await __testHook.triggerGuidedReview('ch1', true);

    expect(mocks.reviewAdd).toHaveBeenCalledTimes(2);
    expect(mocks.reviewAdd).toHaveBeenCalledWith(
      'review',
      { runId: 'r1', candidateId: 'c1', scrapeOutcome: 'ok' },
      { jobId: 'review:discovery:r1-c1-2', attempts: 1 },
    );
    // missing generation defaults to 0.
    expect(mocks.reviewAdd).toHaveBeenCalledWith(
      'review',
      { runId: 'r1', candidateId: 'c2', scrapeOutcome: 'ok' },
      { jobId: 'review:discovery:r1-c2-0', attempts: 1 },
    );
  });

  it('enqueues with scrapeOutcome=failed on a failed scrape', async () => {
    mocks.prisma.discoveryRunCandidate.findMany.mockResolvedValue([
      { id: 'c1', runId: 'r1', provenance: {} },
    ]);

    await __testHook.triggerGuidedReview('ch1', false);

    expect(mocks.reviewAdd).toHaveBeenCalledWith(
      'review',
      { runId: 'r1', candidateId: 'c1', scrapeOutcome: 'failed' },
      { jobId: 'review:discovery:r1-c1-0', attempts: 1 },
    );
  });

  it('no candidates → enqueues nothing', async () => {
    mocks.prisma.discoveryRunCandidate.findMany.mockResolvedValue([]);
    await __testHook.triggerGuidedReview('ch1', true);
    expect(mocks.reviewAdd).not.toHaveBeenCalled();
  });

  it('selector matches re-armed candidates and running|enriching runs', async () => {
    mocks.prisma.discoveryRunCandidate.findMany.mockResolvedValue([]);
    await __testHook.triggerGuidedReview('chX', true);
    const where = (mocks.prisma.discoveryRunCandidate.findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;
    expect(where.channelId).toBe('chX');
    expect(where.run).toEqual({ status: { in: ['running', 'enriching'] } });
    // Must use AnyNull (matches fresh SQL NULL + re-cleared JSON null), not
    // JsonNull which would miss fresh candidates and wedge the run (BUG #1).
    expect(where.OR).toEqual([
      { review: { equals: '__ANY_NULL__' } },
      { enrichmentStatus: 'pending_enrichment' },
    ]);
  });

  it('swallows errors and never throws', async () => {
    mocks.prisma.discoveryRunCandidate.findMany.mockRejectedValue(new Error('db down'));
    await expect(__testHook.triggerGuidedReview('ch1', true)).resolves.toBeUndefined();
  });
});
