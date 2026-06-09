import { Worker, Queue } from 'bullmq';
import { getRedis } from '../redis.js';
import { ChannelScrapeJobZ, QueueNames } from '@nosquare/shared';
import { getPrisma, Prisma } from '@nosquare/db';
import {
  TelegramAdapter,
  InstagramAdapter,
  YoutubeAdapter,
  type ChannelSnapshot,
} from '@nosquare/platforms';
import { getTgClient } from '../services/tg-client.js';
import { getScrapeCreators } from '../services/scrape-creators.js';
import { roleRateLimiter } from '../services/role-rate-limiter.js';
import { logger } from '../logger.js';
import { publishRealtime } from '../services/realtime-emit.js';
import {
  markPostInsightRefreshFailedForChannel,
  upsertPostInsightsFromSnapshot,
} from '../services/post-insights.js';
import { storeTelegramPostImages } from '../services/post-images.js';

const adapters = {
  telegram: new TelegramAdapter(),
  instagram: new InstagramAdapter(),
  youtube: new YoutubeAdapter(),
};

/**
 * Guided-discovery evidence loop hook (fix-guided-discovery-evidence-loop, D3).
 * After a scrape settles (success OR final failure), re-review every still-open
 * `DiscoveryRunCandidate` that references the scraped channel — this is the
 * recovery path that closes BUG #2 (phase 1 left new candidates pending) and
 * makes `scrape_refresh` actually re-score.
 *
 * Best-effort: any error here is logged and swallowed so it never fails the
 * scrape job (the bounded sweep is the backstop). The selector also matches
 * `enrichmentStatus='pending_enrichment'` so a previously-reviewed candidate
 * that was re-armed by `scrape_refresh` (non-null `review`) is re-selected.
 * A deterministic `jobId` (with the per-candidate scrape generation) dedups
 * duplicate hook fires at enqueue time.
 */
async function triggerGuidedReview(channelId: string, scrapeOk: boolean): Promise<void> {
  try {
    const prisma = getPrisma();
    const open = await prisma.discoveryRunCandidate.findMany({
      where: {
        channelId,
        run: { status: { in: ['running', 'enriching'] } },
        // Fresh candidates carry SQL NULL in `review`; a re-armed candidate
        // cleared by the reviewer carries JSON null. `Prisma.AnyNull` matches
        // BOTH (DbNull + JsonNull) — `Prisma.JsonNull` alone would miss the
        // common fresh-candidate case and wedge the run in `enriching`.
        OR: [{ review: { equals: Prisma.AnyNull } }, { enrichmentStatus: 'pending_enrichment' }],
      },
      select: { id: true, runId: true, provenance: true },
    });
    if (open.length === 0) return;
    const reviewQueue = new Queue(QueueNames.guidedDiscoveryReview, { connection: getRedis() });
    for (const c of open) {
      const generation =
        ((c.provenance as { scrapeGeneration?: unknown } | null)?.scrapeGeneration as number) ?? 0;
      await reviewQueue.add(
        'review',
        { runId: c.runId, candidateId: c.id, scrapeOutcome: scrapeOk ? 'ok' : 'failed' },
        // BullMQ rejects a ':'-containing jobId unless it splits into exactly 3
        // parts; this dedup key has 5 segments, so join the variable parts with
        // '-' to keep it valid (was `review:discovery:${runId}:${id}:${gen}`).
        { jobId: `review:discovery:${c.runId}-${c.id}-${generation}`, attempts: 1 },
      );
    }
  } catch (err) {
    logger.warn(
      { channelId, err: err instanceof Error ? err.message : String(err) },
      'guided-discovery review hook failed (non-fatal)',
    );
  }
}

export function startChannelScrapeWorker() {
  const worker = new Worker(
    QueueNames.channelScrape,
    async (job) => {
      const { channelId } = ChannelScrapeJobZ.parse(job.data);
      const prisma = getPrisma();
      const ch = await prisma.channel.findUnique({ where: { id: channelId } });
      if (!ch) throw new Error(`channel ${channelId} not found`);

      await prisma.channel.update({
        where: { id: channelId },
        data: { status: 'scraping', lastError: null },
      });
      await publishRealtime(`channel:${channelId}`, {
        type: 'channel.progress',
        channelId,
        status: 'scraping',
      });

      try {
        const adapter = adapters[ch.platform];
        const tgClient = getTgClient();
        const sc = await getScrapeCreators();
        const handle = adapter.parseHandle(ch.handle)?.handle ?? ch.handle;

        // Pick a healthy parser/both account, rotating across the pool so a
        // single account doesn't take all the load (the historical findFirst
        // path concentrated traffic on one row and tripped FloodWait fast).
        // Healthy = role in (parser, both) AND status NOT IN (need_auth,
        // banned) AND (cooldownUntil IS NULL OR cooldownUntil <= NOW()).
        // Among healthy candidates we prefer the one whose role-RPM window
        // has the soonest free slot — that's effective least-recently-used
        // when TG_PARSER_RPM is set, and uniform random when it isn't.
        let tgAccountId: string | null = null;
        const candidates = await prisma.tgAccount.findMany({
          where: {
            role: { in: ['parser', 'both'] },
            status: { in: ['active', 'idle'] },
            OR: [
              { cooldownUntil: null },
              { cooldownUntil: { lte: new Date() } },
            ],
          },
          select: { id: true, parserRpm: true },
        });
        if (candidates.length > 0) {
          // Shuffle once so equal-priority accounts (RPM unset / all free
          // now) rotate uniformly across jobs.
          for (let i = candidates.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!];
          }
          candidates.sort(
            (a, b) =>
              roleRateLimiter.nextFreeInMs(a.id, 'parser', a.parserRpm) -
              roleRateLimiter.nextFreeInMs(b.id, 'parser', b.parserRpm),
          );
          const picked = candidates[0]!;
          const acq = roleRateLimiter.acquire(picked.id, 'parser', picked.parserRpm);
          if (!acq.ok) {
            // All candidates are over the per-account RPM cap. Tell BullMQ
            // to retry — the healer/window will free a slot soon.
            throw new Error(
              `tg parser pool throttled (per-account parserRpm); retry in ${acq.retryAfterMs}ms`,
            );
          }
          tgAccountId = picked.id;
        } else if (process.env.TG_BOOTSTRAP_ACCOUNT_ID) {
          tgAccountId = process.env.TG_BOOTSTRAP_ACCOUNT_ID;
        }

        const tgHandle =
          tgClient && tgAccountId
            ? await tgClient.for(tgAccountId).catch((e) => {
                logger.warn(
                  { tgAccountId, err: e instanceof Error ? e.message : String(e) },
                  'tg session unavailable for scrape',
                );
                return null;
              })
            : null;

        const snap: ChannelSnapshot = await adapter.scrapeChannel(handle, {
          tgClient: tgHandle ?? undefined,
          scrapeCreators: sc ?? undefined,
        });

        await prisma.channel.update({
          where: { id: channelId },
          data: {
            externalId: snap.externalId,
            title: snap.title,
            description: snap.description,
            links: snap.links,
            followers: snap.followers ?? null,
            language: snap.language ?? null,
            rawData: snap.raw as object,
            status: 'scraped',
            scrapedAt: new Date(),
          },
        });

        const upsert = await upsertPostInsightsFromSnapshot({ channelId, snapshot: snap }).catch(
          (err) => {
            logger.warn(
              { channelId, err: (err as Error).message },
              'post insight upsert failed after channel scrape',
            );
            return null;
          },
        );

        // Store Telegram post-example preview images to S3 (blogger-profile-who-
        // is-this). Best-effort, behind object_storage; uses the parser client's
        // public-post downloader. Other platforms' images are handled at upsert
        // (YouTube thumbnail) or unsupported.
        if (upsert?.profileId && snap.platform === 'telegram' && tgHandle) {
          await storeTelegramPostImages({
            profileId: upsert.profileId,
            handle,
            posts: snap.posts,
            tg: tgHandle,
          }).catch((err) =>
            logger.warn(
              { channelId, err: (err as Error).message },
              'telegram post image store failed (non-fatal)',
            ),
          );
        }

        await publishRealtime(`channel:${channelId}`, {
          type: 'channel.progress',
          channelId,
          status: 'scraped',
        });

        // chain into contact-extract
        const extractQueue = new Queue(QueueNames.contactExtract, { connection: getRedis() });
        await extractQueue.add('extract', { channelId });
        // Guided-discovery success hook (D3): re-review open candidates now that
        // public evidence exists. Best-effort; never fails the scrape.
        await triggerGuidedReview(channelId, true);
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await markPostInsightRefreshFailedForChannel(channelId, msg);
        await prisma.channel.update({
          where: { id: channelId },
          data: { status: 'failed', lastError: msg },
        });
        await publishRealtime(`channel:${channelId}`, {
          type: 'channel.progress',
          channelId,
          status: 'failed',
          detail: msg,
        });
        throw err;
      }
    },
    { connection: getRedis(), concurrency: 4 },
  );

  worker.on('failed', (job, err) => {
    const channelId = (job?.data as { channelId?: string } | undefined)?.channelId;
    logger.error(
      {
        jobId: job?.id,
        channelId,
        errName: err?.name,
        err: err?.message,
        stack: err?.stack,
      },
      'channel-scrape failed',
    );
    // Guided-discovery FINAL-failure hook (D3): only after BullMQ has exhausted
    // retries — otherwise a candidate could be terminally marked
    // insufficient-evidence before a successful retry scrapes the channel.
    // Discovery-originated scrapes use `attempts: 1`, so this fires promptly.
    if (job && channelId) {
      const attempts = job.opts.attempts ?? 1;
      if (job.attemptsMade >= attempts) {
        void triggerGuidedReview(channelId, false);
      }
    }
  });
  return worker;
}

// Exported for unit tests (guided-discovery review hook, D3).
export const __testHook = { triggerGuidedReview };
