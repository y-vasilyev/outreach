import { getPrisma } from '@nosquare/db';
import { Errors } from '@nosquare/shared';
import type {
  DiscoveryBatchInput,
  DiscoveryBatchListItem,
  DiscoveryBatchStatus,
  DiscoveryBatchSummary,
} from '@nosquare/shared';

import { getQueues } from '../queues.js';

/**
 * Async batch channel discovery (batch-channel-discovery change).
 *
 * Operator submits N niches in one request — we create a `DiscoveryBatch`
 * row (status='pending'), enqueue a worker job, and return the id
 * immediately. The worker iterates the niches one-by-one (concurrency 1,
 * ~1s pause between them) and accumulates per-niche results into
 * `summary`. The status endpoint just reads the row.
 */

function toStatus(row: {
  id: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  createdAt: Date;
  completedAt: Date | null;
  platform: string | null;
  limitPerQuery: number;
  summary: unknown;
}): DiscoveryBatchStatus {
  return {
    id: row.id,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    platform: (row.platform as DiscoveryBatchStatus['platform']) ?? null,
    limitPerQuery: row.limitPerQuery,
    summary: (row.summary as DiscoveryBatchSummary) ?? {
      totals: { queries: 0, processed: 0, created: 0, alreadyKnown: 0, errored: 0 },
      queries: [],
    },
  };
}

export const discoveryBatchService = {
  async create(input: DiscoveryBatchInput, createdById: string | null): Promise<{ id: string }> {
    const prisma = getPrisma();
    const queues = getQueues();
    // Seed `summary` with one stub per query so the operator sees the
    // full work list immediately, even before the worker starts.
    const summary: DiscoveryBatchSummary = {
      totals: {
        queries: input.queries.length,
        processed: 0,
        created: 0,
        alreadyKnown: 0,
        errored: 0,
      },
      queries: input.queries.map((q) => ({
        query: q,
        done: false,
        candidates: [],
        created: 0,
        alreadyKnown: 0,
      })),
    };
    const batch = await prisma.discoveryBatch.create({
      data: {
        queries: input.queries as object,
        platform: input.platform ?? null,
        limitPerQuery: input.limit_per_query,
        status: 'pending',
        summary: summary as object,
        createdById,
      },
    });
    await queues.discoveryBatch.add('process', { batchId: batch.id });
    return { id: batch.id };
  },

  async get(id: string): Promise<DiscoveryBatchStatus> {
    const prisma = getPrisma();
    const row = await prisma.discoveryBatch.findUnique({ where: { id } });
    if (!row) throw Errors.notFound('discovery_batch', id);
    return toStatus(row);
  },

  async list(): Promise<DiscoveryBatchListItem[]> {
    const prisma = getPrisma();
    // Compact projection: skip per-query candidates entirely; just
    // surface row metadata + totals. Keeps the response small (a single
    // batch can carry ~200 KB of candidates and a list of 20 such
    // batches would otherwise be ~4 MB).
    const rows = await prisma.discoveryBatch.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        status: true,
        createdAt: true,
        completedAt: true,
        platform: true,
        limitPerQuery: true,
        summary: true,
      },
    });
    return rows.map((row) => {
      const summary = (row.summary as DiscoveryBatchSummary | null) ?? {
        totals: { queries: 0, processed: 0, created: 0, alreadyKnown: 0, errored: 0 },
        queries: [],
      };
      return {
        id: row.id,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
        platform: (row.platform as DiscoveryBatchListItem['platform']) ?? null,
        limitPerQuery: row.limitPerQuery,
        totals: summary.totals,
      };
    });
  },
};
