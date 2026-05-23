import { Queue } from 'bullmq';
import { getPrisma } from '@nosquare/db';
import { QueueNames } from '@nosquare/shared';
import { getRedis } from '../redis.js';
import { logger } from '../logger.js';

const INTERVAL_MS = 60 * 60 * 1000;
const LOOKBACK_MS = 2 * 60 * 60 * 1000;
const SAMPLE_RATE = 0.1;

export function startQualityReviewScheduler() {
  let stopping = false;
  const queue = new Queue(QueueNames.agentRun, { connection: getRedis() });

  const tick = async () => {
    if (stopping) return;
    const prisma = getPrisma();
    const since = new Date(Date.now() - LOOKBACK_MS);
    const rows = await prisma.message.findMany({
      where: {
        direction: 'out_',
        status: 'sent',
        createdAt: { gte: since },
      },
      select: {
        conversationId: true,
        createdAt: true,
        conversation: { select: { contactId: true, campaignId: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    let queued = 0;
    for (const row of rows) {
      if (Math.random() > SAMPLE_RATE) continue;
      const alreadyReviewed = await prisma.agentRun.findFirst({
        where: {
          agentName: 'quality_reviewer',
          conversationId: row.conversationId,
          createdAt: { gte: row.createdAt },
        },
        select: { id: true },
      });
      if (alreadyReviewed) continue;
      await queue.add(
        'quality_review',
        {
          pipeline: 'quality_review',
          conversationId: row.conversationId,
          contactId: row.conversation.contactId,
          ...(row.conversation.campaignId ? { campaignId: row.conversation.campaignId } : {}),
        },
        {
          jobId: `quality_review:${row.conversationId}:${row.createdAt.getTime()}`,
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
      queued += 1;
    }
    if (queued > 0) logger.info({ queued }, 'quality-review scheduler queued reviews');
  };

  const handle = setInterval(() => void tick().catch((err) => {
    logger.warn({ err: (err as Error).message }, 'quality-review scheduler tick failed');
  }), INTERVAL_MS);
  void tick().catch((err) => {
    logger.warn({ err: (err as Error).message }, 'quality-review scheduler initial tick failed');
  });

  return {
    stop: async () => {
      stopping = true;
      clearInterval(handle);
      await queue.close().catch(() => undefined);
    },
  };
}
