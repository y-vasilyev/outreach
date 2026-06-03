import { Worker, Queue } from 'bullmq';
import { getRedis } from '../redis.js';
import { ChannelScrapeJobZ, QueueNames } from '@nosquare/shared';
import { getPrisma } from '@nosquare/db';
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

const adapters = {
  telegram: new TelegramAdapter(),
  instagram: new InstagramAdapter(),
  youtube: new YoutubeAdapter(),
};

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

        await publishRealtime(`channel:${channelId}`, {
          type: 'channel.progress',
          channelId,
          status: 'scraped',
        });

        // chain into contact-extract
        const extractQueue = new Queue(QueueNames.contactExtract, { connection: getRedis() });
        await extractQueue.add('extract', { channelId });
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
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

  worker.on('failed', (job, err) =>
    logger.error(
      {
        jobId: job?.id,
        channelId: (job?.data as { channelId?: string } | undefined)?.channelId,
        errName: err?.name,
        err: err?.message,
        stack: err?.stack,
      },
      'channel-scrape failed',
    ),
  );
  return worker;
}
