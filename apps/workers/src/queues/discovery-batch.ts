import { Queue, Worker } from 'bullmq';
import { getPrisma, decryptJson } from '@nosquare/db';
import {
  DiscoveryBatchJobZ,
  QueueNames,
  type DiscoveryBatchSummary,
  type DiscoveryBatchPerQuery,
} from '@nosquare/shared';
import { YandexSearchClient, extractCandidates } from '@nosquare/platforms';
import type { Platform } from '@nosquare/shared';

import { getRedis } from '../redis.js';
import { logger } from '../logger.js';

interface YandexSearchConfig {
  apiKey: string;
  folderId: string;
  baseUrl?: string;
}

function recomputeTotals(queries: DiscoveryBatchPerQuery[]): DiscoveryBatchSummary['totals'] {
  const t = { queries: queries.length, processed: 0, created: 0, alreadyKnown: 0, errored: 0 };
  for (const q of queries) {
    if (q.done) t.processed += 1;
    t.created += q.created ?? 0;
    t.alreadyKnown += q.alreadyKnown ?? 0;
    if (q.error) t.errored += 1;
  }
  return t;
}

/**
 * Batch channel discovery worker (batch-channel-discovery change).
 *
 * Pulls a `DiscoveryBatch` row, iterates its `queries` one-by-one, and
 * for each niche runs the same Yandex Search → normalize → persist new
 * channels → enqueue `channel-scrape` pipeline the single `/discovery/
 * search` endpoint uses. Per-niche failures don't abort the batch —
 * they're written into `summary.queries[i].error` and the loop
 * continues.
 *
 * NB: the inner per-niche loop duplicates ~30 lines of logic with
 * `apps/api/src/services/discovery.ts#search`. Kept as a deliberate
 * duplication to avoid a cross-app shared dependency just for one
 * helper; if/when more discovery code accumulates here, factor the
 * `searchCore(prisma, queues, client, ...)` function into a shared
 * spot and have both call sites use it.
 */
async function handleDiscoveryBatch(data: { batchId: string }): Promise<void> {
  const prisma = getPrisma();
  // Local handle to the channel-scrape queue (same shape as
  // channel-scrape.ts). Created lazily so unit tests can ignore it.
  const scrapeQueue = new Queue(QueueNames.channelScrape, { connection: getRedis() });
  // Hoisted so the outer fatal-catch can write the most-recent in-memory
  // summary back to the DB if a post-claim throw interrupts the loop —
  // otherwise we'd overwrite real per-niche progress with the stale
  // snapshot loaded at batch-find time.
  let summary: DiscoveryBatchSummary | null = null;
  let batchId: string = data.batchId;
  const batch = await prisma.discoveryBatch.findUnique({ where: { id: data.batchId } });
  if (!batch) {
    logger.warn({ batchId: data.batchId }, 'discovery-batch: row missing, skipping');
    return;
  }
  if (batch.status === 'done' || batch.status === 'failed') {
    // Terminal state — nothing to do.
    logger.info(
      { batchId: data.batchId, status: batch.status },
      'discovery-batch: terminal status, skipping',
    );
    return;
  }

  // Atomic claim with staleness gate.
  //
  // - A `pending` row can always be claimed (fresh start).
  // - A `running` row can ONLY be claimed if it hasn't been touched for
  //   `STALE_LOCK_MS` — i.e. the previous worker is presumed dead. This
  //   prevents two concurrent workers from both claiming a row that's
  //   actively being processed: as long as the live worker calls
  //   `prisma.discoveryBatch.update(...)` between iterations (which it
  //   does after every niche), Prisma's `@updatedAt` renews the lock and
  //   any concurrent retry sees a fresh `updatedAt > NOW - STALE_LOCK_MS`
  //   and bails out.
  //
  // When this worker hits a niche that takes longer than STALE_LOCK_MS
  // (e.g. a hung Yandex Search call), a stalled BullMQ retry could
  // race in. We treat that as acceptable risk for now — the per-niche
  // skip-when-done loop bounds blast radius to one duplicated niche, and
  // an admin-side timeout on `client.search(...)` would fix this end of
  // the problem in follow-up.
  const STALE_LOCK_MS = 2 * 60 * 1000;
  const staleBefore = new Date(Date.now() - STALE_LOCK_MS);
  const claim = await prisma.discoveryBatch.updateMany({
    where: {
      id: batch.id,
      OR: [
        { status: 'pending' },
        { status: 'running', updatedAt: { lt: staleBefore } },
      ],
    },
    data: { status: 'running' },
  });
  if (claim.count !== 1) {
    logger.info(
      { batchId: data.batchId, currentStatus: batch.status },
      'discovery-batch: lost claim race (active worker already owns this batch)',
    );
    return;
  }

  // Everything after the claim is wrapped in try/catch so an
  // unexpected throw (decrypt, client construction, prisma flake)
  // marks the row `failed` with a `fatalError` instead of leaving it
  // `running` forever. The per-niche failures stay inside the inner
  // try/catch and don't reach here.
  try {
  // Load Yandex integ once for the whole batch.
  const integ = await prisma.integration.findUnique({ where: { kind: 'yandex_search' } });
  if (!integ || !integ.enabled) {
    await prisma.discoveryBatch.update({
      where: { id: batch.id },
      data: {
        status: 'failed',
        completedAt: new Date(),
        summary: {
          ...(batch.summary as object),
          totals: {
            queries: (batch.queries as string[]).length,
            processed: 0,
            created: 0,
            alreadyKnown: 0,
            errored: 0,
          },
          fatalError: 'yandex_search integration not configured/disabled',
        } as object,
      },
    });
    return;
  }
  const cfg = await decryptJson<YandexSearchConfig>(integ.configEncrypted);
  if (!cfg?.apiKey || !cfg?.folderId) {
    await prisma.discoveryBatch.update({
      where: { id: batch.id },
      data: {
        status: 'failed',
        completedAt: new Date(),
        summary: {
          ...(batch.summary as object),
          fatalError: 'yandex_search integration missing apiKey/folderId',
        } as object,
      },
    });
    return;
  }
  const client = new YandexSearchClient({
    apiKey: cfg.apiKey,
    folderId: cfg.folderId,
    ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
  });

  // `status='running'` was already set by the atomic claim above.

  const queries = batch.queries as string[];
  // `batch.platform` is `string | null` from the DB; the extractCandidates
  // call wants the typed `Platform` enum. Narrow with a cast — Zod-
  // validated on the way in via `DiscoveryBatchInputZ.platform`, so this
  // is safe.
  const platform = (batch.platform ?? undefined) as Platform | undefined;
  const limit = batch.limitPerQuery;
  // Assign to the hoisted `summary` so the outer fatal-catch sees the
  // most-recent in-memory state.
  summary = (batch.summary as DiscoveryBatchSummary) ?? {
    totals: {
      queries: queries.length,
      processed: 0,
      created: 0,
      alreadyKnown: 0,
      errored: 0,
    },
    queries: queries.map((q) => ({
      query: q,
      done: false,
      candidates: [],
      created: 0,
      alreadyKnown: 0,
    })),
  };
  batchId = batch.id;

  for (let i = 0; i < queries.length; i += 1) {
    const query = queries[i] as string;
    const perQuery: DiscoveryBatchPerQuery = summary.queries[i] ?? {
      query,
      done: false,
      candidates: [],
      created: 0,
      alreadyKnown: 0,
    };
    // Resume: a previous worker run may have completed this niche
    // before crashing. Skip it (its results are already in summary).
    // Totals are recomputed deterministically at the end.
    if (perQuery.done) {
      continue;
    }
    try {
      const results = await client.search(query);
      const candidates = extractCandidates(
        results,
        platform ? { platform } : {},
      ).slice(0, limit);
      const source = `search:${query}`;
      let created = 0;
      let alreadyKnown = 0;
      const perCandidate = [] as DiscoveryBatchPerQuery['candidates'];

      for (const c of candidates) {
        const existing = await prisma.channel.findUnique({
          where: { platform_handle: { platform: c.platform, handle: c.handle } },
          select: { id: true },
        });
        if (existing) {
          alreadyKnown += 1;
          perCandidate.push({
            platform: c.platform,
            handle: c.handle,
            url: c.url,
            title: c.title,
            alreadyKnown: true,
          });
          continue;
        }
        let ch: { id: string };
        try {
          ch = await prisma.channel.create({
            data: {
              platform: c.platform,
              handle: c.handle,
              status: 'new',
              source,
              addedById: batch.createdById,
              links: [],
            },
          });
        } catch {
          // findUnique→create race (the @@unique fired). Treat as known.
          alreadyKnown += 1;
          perCandidate.push({
            platform: c.platform,
            handle: c.handle,
            url: c.url,
            title: c.title,
            alreadyKnown: true,
          });
          continue;
        }
        created += 1;
        await scrapeQueue.add('scrape', { channelId: ch.id });
        perCandidate.push({
          platform: c.platform,
          handle: c.handle,
          url: c.url,
          title: c.title,
          alreadyKnown: false,
        });
      }

      perQuery.candidates = perCandidate;
      perQuery.created = created;
      perQuery.alreadyKnown = alreadyKnown;
      perQuery.done = true;
    } catch (err) {
      perQuery.error = (err as Error).message;
      perQuery.done = true;
      logger.warn(
        { batchId: batch.id, query, err: (err as Error).message },
        'discovery-batch: per-query failure (recorded, continuing)',
      );
    }
    summary.queries[i] = perQuery;
    // Recompute totals deterministically from queries so retries
    // produce the same numbers as a fresh run (no double-counting,
    // no off-by-one on resume).
    summary.totals = recomputeTotals(summary.queries);

    await prisma.discoveryBatch.update({
      where: { id: batch.id },
      data: { summary: summary as object },
    });

    // Rate-limit pause between niches. Skip after the last one.
    if (i < queries.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  // Final recompute (cheap; defensive against any code path above
  // forgetting an update).
  summary.totals = recomputeTotals(summary.queries);
  await prisma.discoveryBatch.update({
    where: { id: batch.id },
    data: {
      status: 'done',
      completedAt: new Date(),
      summary: summary as object,
    },
  });
  logger.info(
    {
      batchId: batch.id,
      totals: summary.totals,
    },
    'discovery-batch: done',
  );
  } catch (err) {
    // Setup or unexpected post-claim throw — mark `failed` with the
    // error captured so the row never stays stuck `running`. Use the
    // hoisted in-memory `summary` if any niches already finished, so we
    // don't overwrite real progress with the stale find-time snapshot.
    // Best-effort (we're already on the failure path).
    logger.error(
      { batchId, err: (err as Error).message },
      'discovery-batch: unexpected error after claim; marking failed',
    );
    const fatalSummary = summary
      ? { ...summary, fatalError: `worker error: ${(err as Error).message}` }
      : { ...(batch?.summary as object | undefined ?? {}), fatalError: `worker error: ${(err as Error).message}` };
    await prisma.discoveryBatch
      .update({
        where: { id: batchId },
        data: {
          status: 'failed',
          completedAt: new Date(),
          summary: fatalSummary as object,
        },
      })
      .catch(() => undefined);
  }
}

export function startDiscoveryBatchWorker() {
  return new Worker(
    QueueNames.discoveryBatch,
    async (job) => {
      const data = DiscoveryBatchJobZ.parse(job.data);
      await handleDiscoveryBatch(data);
    },
    {
      connection: getRedis(),
      // Yandex Search API is rate-limited; sequential processing keeps
      // bursts predictable across multiple concurrent batches too.
      concurrency: 1,
    },
  );
}

// Exported for unit tests.
export const __internal = { handleDiscoveryBatch };
