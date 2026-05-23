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

        // Pick the first authorized parser/both account from the DB. Falls
        // back to the env-supplied bootstrap account id only when no DB rows
        // exist (useful for first-time integration tests with TG_SESSION_STRING).
        let tgAccountId: string | null = null;
        const parser = await prisma.tgAccount.findFirst({
          where: { status: 'active', role: { in: ['parser', 'both'] } },
          orderBy: { updatedAt: 'desc' },
          select: { id: true },
        });
        if (parser) tgAccountId = parser.id;
        else if (process.env.TG_BOOTSTRAP_ACCOUNT_ID) tgAccountId = process.env.TG_BOOTSTRAP_ACCOUNT_ID;

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
