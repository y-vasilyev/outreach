import { startChannelScrapeWorker } from './queues/channel-scrape.js';
import { startContactExtractWorker } from './queues/contact-extract.js';
import { startTgSendWorker } from './queues/tg-send.js';
import { startAgentRunWorker } from './queues/agent-run.js';
import { startCampaignDispatcher } from './queues/campaign-dispatcher.js';
import { logger } from './logger.js';

async function main() {
  logger.info('Starting workers…');

  const workers = [
    startChannelScrapeWorker(),
    startContactExtractWorker(),
    startTgSendWorker(),
    startAgentRunWorker(),
  ];
  const dispatcher = startCampaignDispatcher();

  logger.info('Workers ready.');

  const shutdown = async () => {
    logger.info('Shutting down workers…');
    dispatcher.stop();
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
