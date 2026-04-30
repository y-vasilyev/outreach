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

        const tgHandle = tgClient ? await tgClient.for('parser-default').catch(() => null) : null;

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
    logger.error({ jobId: job?.id, err: err?.message }, 'channel-scrape failed'),
  );
  return worker;
}
