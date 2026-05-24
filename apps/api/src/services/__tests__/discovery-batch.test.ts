import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAppError } from '@nosquare/shared/errors';

/**
 * Batch discovery service: create persists a `DiscoveryBatch(pending)`,
 * enqueues the worker job once, and returns the id. get/list read rows
 * back through the prisma mock. The actual per-niche pipeline is the
 * worker's concern — see `apps/workers/src/__tests__/discoveryBatch.test.ts`.
 */

const mocks = vi.hoisted(() => {
  const prisma = {
    discoveryBatch: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
  };
  const batchAdd = vi.fn(async () => ({}));
  return { prisma, batchAdd };
});

vi.mock('@nosquare/db', () => ({ getPrisma: () => mocks.prisma }));
vi.mock('../../queues.js', () => ({
  getQueues: () => ({ discoveryBatch: { add: mocks.batchAdd } }),
}));

import { discoveryBatchService } from '../discovery-batch.js';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('discoveryBatchService.create', () => {
  it('persists a DiscoveryBatch row with seeded summary and enqueues the worker', async () => {
    mocks.prisma.discoveryBatch.create.mockResolvedValue({ id: 'batch_1' });
    const out = await discoveryBatchService.create(
      { queries: ['ниша 1', 'ниша 2'], limit_per_query: 15 },
      'user_1',
    );
    expect(out).toEqual({ id: 'batch_1' });
    expect(mocks.prisma.discoveryBatch.create).toHaveBeenCalledTimes(1);
    const createArg = mocks.prisma.discoveryBatch.create.mock.calls[0]![0] as {
      data: { queries: unknown; status: string; limitPerQuery: number; summary: { queries: unknown[]; totals: { queries: number } } };
    };
    expect(createArg.data.queries).toEqual(['ниша 1', 'ниша 2']);
    expect(createArg.data.status).toBe('pending');
    expect(createArg.data.limitPerQuery).toBe(15);
    expect(createArg.data.summary.queries).toHaveLength(2);
    expect(createArg.data.summary.totals.queries).toBe(2);
    expect(mocks.batchAdd).toHaveBeenCalledWith('process', { batchId: 'batch_1' });
  });

  it('passes platform through when provided', async () => {
    mocks.prisma.discoveryBatch.create.mockResolvedValue({ id: 'batch_2' });
    await discoveryBatchService.create(
      { queries: ['x'], platform: 'telegram', limit_per_query: 20 },
      'user_2',
    );
    const createArg = mocks.prisma.discoveryBatch.create.mock.calls[0]![0] as {
      data: { platform: string | null };
    };
    expect(createArg.data.platform).toBe('telegram');
  });
});

describe('discoveryBatchService.get', () => {
  it('returns a serialized status for an existing batch', async () => {
    const now = new Date('2026-05-24T12:00:00.000Z');
    mocks.prisma.discoveryBatch.findUnique.mockResolvedValue({
      id: 'batch_1',
      status: 'running',
      createdAt: now,
      completedAt: null,
      platform: null,
      limitPerQuery: 20,
      summary: {
        totals: { queries: 2, processed: 1, created: 5, alreadyKnown: 1, errored: 0 },
        queries: [
          { query: 'ниша 1', done: true, candidates: [], created: 5, alreadyKnown: 1 },
          { query: 'ниша 2', done: false, candidates: [], created: 0, alreadyKnown: 0 },
        ],
      },
    });
    const status = await discoveryBatchService.get('batch_1');
    expect(status.id).toBe('batch_1');
    expect(status.status).toBe('running');
    expect(status.createdAt).toBe('2026-05-24T12:00:00.000Z');
    expect(status.completedAt).toBeNull();
    expect(status.summary.totals.processed).toBe(1);
    expect(status.summary.queries[0]!.done).toBe(true);
  });

  it('throws not_found for a missing id', async () => {
    mocks.prisma.discoveryBatch.findUnique.mockResolvedValue(null);
    try {
      await discoveryBatchService.get('nope');
      expect.unreachable();
    } catch (e) {
      expect(isAppError(e)).toBe(true);
    }
  });
});

describe('discoveryBatchService.list', () => {
  it('returns compact rows (totals only, no per-query candidates)', async () => {
    mocks.prisma.discoveryBatch.findMany.mockResolvedValue([
      {
        id: 'batch_2',
        status: 'done',
        createdAt: new Date('2026-05-24T12:00:00.000Z'),
        completedAt: new Date('2026-05-24T12:05:00.000Z'),
        platform: 'telegram',
        limitPerQuery: 20,
        summary: {
          totals: { queries: 3, processed: 3, created: 6, alreadyKnown: 0, errored: 0 },
          queries: [
            { query: 'a', done: true, candidates: [{ platform: 'telegram', handle: 'x', url: '', title: '', alreadyKnown: false }], created: 1, alreadyKnown: 0 },
          ],
        },
      },
    ]);
    const out = await discoveryBatchService.list();
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('batch_2');
    expect(out[0]!.status).toBe('done');
    expect(out[0]!.completedAt).toBe('2026-05-24T12:05:00.000Z');
    expect(out[0]!.totals.created).toBe(6);
    // No `summary.queries` in the list item — only totals.
    expect((out[0] as unknown as { summary?: unknown }).summary).toBeUndefined();
    expect(mocks.prisma.discoveryBatch.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: expect.any(Object),
    });
  });
});
