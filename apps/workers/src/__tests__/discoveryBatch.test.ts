import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Worker handler for the `discovery-batch` queue. Verifies the
 * per-niche failure isolation: one bad niche's error lives in summary,
 * the rest continue, terminal status is `done` with `errored >= 1`.
 *
 * Yandex client, queue, and prisma mocked — no network/DB/Redis.
 */

const mocks = vi.hoisted(() => {
  const prisma = {
    discoveryBatch: {
      findUnique: vi.fn(),
      update: vi.fn(async () => ({})),
      // Atomic claim path — default to "we won the claim" so most tests
      // proceed into the loop; override to `{ count: 0 }` for the
      // lost-race scenario.
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    integration: { findUnique: vi.fn() },
    channel: { findUnique: vi.fn(), create: vi.fn() },
  };
  const scrapeAdd = vi.fn(async () => ({}));
  const search = vi.fn();
  const candidates = vi.fn(
    (..._args: unknown[]) => [] as Array<{ platform: string; handle: string; url: string; title: string }>,
  );
  const decrypt = vi.fn(async () => ({ apiKey: 'k', folderId: 'f' }));
  return { prisma, scrapeAdd, search, candidates, decrypt };
});

vi.mock('@nosquare/db', () => ({ getPrisma: () => mocks.prisma, decryptJson: mocks.decrypt }));
vi.mock('@nosquare/platforms', () => ({
  YandexSearchClient: class {
    search = mocks.search;
  },
  extractCandidates: (...args: unknown[]) => mocks.candidates(...args),
}));

// `new Queue(...)` is instantiated inside the handler; route any
// `add('scrape', ...)` invocation through the mock so we can verify
// enqueue counts without spinning up Redis.
vi.mock('bullmq', () => {
  class Queue {
    add = mocks.scrapeAdd;
  }
  class Worker {}
  return { Queue, Worker };
});

vi.mock('../redis.js', () => ({ getRedis: () => ({}) }));

import { __internal } from '../queues/discovery-batch.js';

const { handleDiscoveryBatch } = __internal;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.integration.findUnique.mockResolvedValue({
    kind: 'yandex_search',
    enabled: true,
    configEncrypted: 'enc',
  });
  mocks.decrypt.mockResolvedValue({ apiKey: 'k', folderId: 'f' });
  mocks.prisma.channel.findUnique.mockResolvedValue(null);
  mocks.prisma.channel.create.mockResolvedValue({ id: 'ch_new' });
  // Speed: avoid the real 1s rate-limit pause between niches.
  vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleDiscoveryBatch', () => {
  it('processes 3 niches: one throws, two succeed; batch ends `done`', async () => {
    mocks.prisma.discoveryBatch.findUnique.mockResolvedValue({
      id: 'batch_1',
      status: 'pending',
      queries: ['n1', 'n2', 'n3'],
      platform: null,
      limitPerQuery: 20,
      createdById: 'user_1',
      summary: {
        totals: { queries: 3, processed: 0, created: 0, alreadyKnown: 0, errored: 0 },
        queries: [
          { query: 'n1', done: false, candidates: [], created: 0, alreadyKnown: 0 },
          { query: 'n2', done: false, candidates: [], created: 0, alreadyKnown: 0 },
          { query: 'n3', done: false, candidates: [], created: 0, alreadyKnown: 0 },
        ],
      },
    });
    // Niche 1 → one new candidate. Niche 2 → throw. Niche 3 → empty.
    mocks.search
      .mockResolvedValueOnce([{ url: 'https://t.me/x', title: 't1', snippet: 's1' }])
      .mockRejectedValueOnce(new Error('yandex 503'))
      .mockResolvedValueOnce([]);
    mocks.candidates
      .mockReturnValueOnce([{ platform: 'telegram', handle: 'x', url: 'https://t.me/x', title: 't1' }])
      .mockReturnValueOnce([])
      .mockReturnValueOnce([]);

    await handleDiscoveryBatch({ batchId: 'batch_1' });

    // The atomic claim was made exactly once.
    expect(mocks.prisma.discoveryBatch.updateMany).toHaveBeenCalledTimes(1);
    // Final terminal write: status='done' + totals recomputed.
    const updates = mocks.prisma.discoveryBatch.update.mock.calls as Array<unknown[]>;
    expect(updates.length).toBeGreaterThan(0);
    const last = updates[updates.length - 1]![0] as {
      data: { status: string; summary: { totals: { errored: number; created: number } } };
    };
    expect(last.data.status).toBe('done');
    expect(last.data.summary.totals.errored).toBe(1);
    expect(last.data.summary.totals.created).toBe(1);
    expect(mocks.scrapeAdd).toHaveBeenCalledTimes(1);
  });

  it('skips when the row is missing', async () => {
    mocks.prisma.discoveryBatch.findUnique.mockResolvedValue(null);
    await handleDiscoveryBatch({ batchId: 'nope' });
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.prisma.discoveryBatch.update).not.toHaveBeenCalled();
  });

  it('skips a terminal row (done/failed retry guard)', async () => {
    mocks.prisma.discoveryBatch.findUnique.mockResolvedValue({
      id: 'batch_2',
      status: 'done',
      queries: ['x'],
      platform: null,
      limitPerQuery: 20,
      createdById: null,
      summary: { totals: {}, queries: [] },
    });
    await handleDiscoveryBatch({ batchId: 'batch_2' });
    expect(mocks.prisma.discoveryBatch.updateMany).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it('bails out when the atomic claim race is lost (updateMany count=0)', async () => {
    mocks.prisma.discoveryBatch.findUnique.mockResolvedValue({
      id: 'batch_2b',
      status: 'running',
      queries: ['x'],
      platform: null,
      limitPerQuery: 20,
      createdById: null,
      summary: {
        totals: { queries: 1, processed: 0, created: 0, alreadyKnown: 0, errored: 0 },
        queries: [{ query: 'x', done: false, candidates: [], created: 0, alreadyKnown: 0 }],
      },
    });
    mocks.prisma.discoveryBatch.updateMany.mockResolvedValueOnce({ count: 0 });
    await handleDiscoveryBatch({ batchId: 'batch_2b' });
    expect(mocks.search).not.toHaveBeenCalled();
    // No update beyond the (failed) claim.
    expect(mocks.prisma.discoveryBatch.update).not.toHaveBeenCalled();
  });

  it('resumes a partially-processed batch: niches with done=true are skipped', async () => {
    mocks.prisma.discoveryBatch.findUnique.mockResolvedValue({
      id: 'batch_resume',
      status: 'running',
      queries: ['n1', 'n2'],
      platform: null,
      limitPerQuery: 20,
      createdById: null,
      summary: {
        totals: { queries: 2, processed: 1, created: 3, alreadyKnown: 0, errored: 0 },
        queries: [
          // Already finished in a previous (crashed) worker run.
          { query: 'n1', done: true, candidates: [], created: 3, alreadyKnown: 0 },
          { query: 'n2', done: false, candidates: [], created: 0, alreadyKnown: 0 },
        ],
      },
    });
    mocks.search.mockResolvedValueOnce([]);
    mocks.candidates.mockReturnValueOnce([]);
    await handleDiscoveryBatch({ batchId: 'batch_resume' });
    // Only the second niche was searched.
    expect(mocks.search).toHaveBeenCalledTimes(1);
    const updates = mocks.prisma.discoveryBatch.update.mock.calls as Array<unknown[]>;
    const last = updates[updates.length - 1]![0] as {
      data: { status: string; summary: { totals: { processed: number; created: number } } };
    };
    expect(last.data.status).toBe('done');
    // Totals reflect both n1 (preserved) and n2 (just processed).
    expect(last.data.summary.totals.created).toBe(3);
    expect(last.data.summary.totals.processed).toBe(2);
  });

  it('marks the batch failed when an unexpected post-claim error throws (outer catch)', async () => {
    mocks.prisma.discoveryBatch.findUnique.mockResolvedValue({
      id: 'batch_oc',
      status: 'pending',
      queries: ['x'],
      platform: null,
      limitPerQuery: 20,
      createdById: null,
      summary: { totals: {}, queries: [] },
    });
    // Integration is fine; the decrypt step throws — simulates a key
    // rotation drift or a broken integration row that passed the
    // enabled check.
    mocks.prisma.integration.findUnique.mockResolvedValue({
      kind: 'yandex_search',
      enabled: true,
      configEncrypted: 'enc',
    });
    mocks.decrypt.mockRejectedValueOnce(new Error('decrypt failed'));
    await handleDiscoveryBatch({ batchId: 'batch_oc' });
    const updates = mocks.prisma.discoveryBatch.update.mock.calls as Array<unknown[]>;
    const last = updates[updates.length - 1]![0] as {
      data: { status: string; summary: { fatalError: string } };
    };
    expect(last.data.status).toBe('failed');
    expect(last.data.summary.fatalError).toMatch(/worker error.*decrypt failed/);
  });

  it('marks the batch failed when the yandex_search integration is missing', async () => {
    mocks.prisma.discoveryBatch.findUnique.mockResolvedValue({
      id: 'batch_3',
      status: 'pending',
      queries: ['x'],
      platform: null,
      limitPerQuery: 20,
      createdById: null,
      summary: { totals: {}, queries: [] },
    });
    mocks.prisma.integration.findUnique.mockResolvedValue(null);
    await handleDiscoveryBatch({ batchId: 'batch_3' });
    const updates = mocks.prisma.discoveryBatch.update.mock.calls as Array<unknown[]>;
    expect(updates.length).toBeGreaterThan(0);
    const last = updates[updates.length - 1]![0] as { data: { status: string; summary: { fatalError: string } } };
    expect(last.data.status).toBe('failed');
    expect(last.data.summary.fatalError).toMatch(/yandex_search/);
  });
});
