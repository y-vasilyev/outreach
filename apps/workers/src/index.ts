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
import { startDiscoveryBatchWorker } from './queues/discovery-batch.js';
import { startGuidedDiscoveryWorker } from './queues/guided-discovery.js';
import { startGuidedDiscoveryReviewWorker } from './queues/guided-discovery-review.js';
import { initFeatureFlags } from './feature-flags.js';
import { startCooldownHealer } from './services/cooldown-healer.js';
import { startWarmupPromoter } from './services/warmup-promoter.js';
import { logger } from './logger.js';

async function main() {
  logger.info('Starting workers…');

  // Load the feature-flag cache + subscribe to invalidation before any job
  // runs, so the inbound hot path reads correct flag state from the first
  // message (runtime-feature-flags).
  await initFeatureFlags();

  const workers = [
    startChannelScrapeWorker(),
    startContactExtractWorker(),
    startTgSendWorker(),
    startAgentRunWorker(),
    startTgListenWorker(),
    startProfileExtractWorker(),
    startDiscoveryBatchWorker(),
    startGuidedDiscoveryWorker(),
    startGuidedDiscoveryReviewWorker(),
  ];
  const dispatcher = startCampaignDispatcher();
  const followups = startFollowupScheduler();
  const qualityReviews = startQualityReviewScheduler();
  const cooldownHealer = startCooldownHealer();
  const warmupPromoter = startWarmupPromoter();
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
    cooldownHealer.stop();
    warmupPromoter.stop();
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
