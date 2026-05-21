import { startChannelScrapeWorker } from './queues/channel-scrape.js';
import { startContactExtractWorker } from './queues/contact-extract.js';
import { startTgSendWorker } from './queues/tg-send.js';
import { startAgentRunWorker } from './queues/agent-run.js';
import { startCampaignDispatcher } from './queues/campaign-dispatcher.js';
import {
  startTgListenWorker,
  startTgListenSubscribers,
} from './queues/tg-listen.js';
import { startFollowupScheduler } from './queues/followup-scheduler.js';
import { startQualityReviewScheduler } from './queues/quality-review-scheduler.js';
import { startProfileExtractWorker } from './queues/profile-extract.js';
import { logger } from './logger.js';

async function main() {
  logger.info('Starting workers…');

  const workers = [
    startChannelScrapeWorker(),
    startContactExtractWorker(),
    startTgSendWorker(),
    startAgentRunWorker(),
    startTgListenWorker(),
    startProfileExtractWorker(),
  ];
  const dispatcher = startCampaignDispatcher();
  const followups = startFollowupScheduler();
  const qualityReviews = startQualityReviewScheduler();
  // TG inbound subscribers connect to live sessions. Failures are logged
  // but don't prevent boot — the queue worker still drains anything that
  // was already enqueued by a previous run.
  const subscribers = await startTgListenSubscribers().catch((err) => {
    logger.warn(
      { err: (err as Error).message },
      'tg-listen subscribers failed to bind',
    );
    return { stop: async () => undefined };
  });

  logger.info('Workers ready.');

  const shutdown = async () => {
    logger.info('Shutting down workers…');
    dispatcher.stop();
    await followups.stop();
    await qualityReviews.stop();
    await subscribers.stop().catch(() => undefined);
    for (const w of workers) {
      await w.close().catch(() => undefined);
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.error({ err }, 'workers fatal');
  process.exit(1);
});
