import { Queue } from 'bullmq';
import { getPrisma } from '@nosquare/db';
import { QueueNames } from '@nosquare/shared';
import { getRedis } from '../redis.js';
import { logger } from '../logger.js';

const INTERVAL_MS = 15 * 60 * 1000;
const SILENCE_MS = 48 * 60 * 60 * 1000;

export function startFollowupScheduler() {
  let stopping = false;
  const queue = new Queue(QueueNames.agentRun, { connection: getRedis() });

  const tick = async () => {
    if (stopping) return;
    const prisma = getPrisma();
    const cutoff = new Date(Date.now() - SILENCE_MS);
    const conversations = await prisma.conversation.findMany({
      where: {
        status: 'active',
        lastOutboundAt: { lt: cutoff },
        suggestions: {
          none: {
            agentName: 'reply_composer',
            status: 'pending',
          },
        },
      },
      select: { id: true, contactId: true, campaignId: true, lastInboundAt: true, lastOutboundAt: true },
      take: 100,
      orderBy: { lastOutboundAt: 'asc' },
    });

    for (const c of conversations.filter(
      (c) => !c.lastInboundAt || (c.lastOutboundAt && c.lastInboundAt < c.lastOutboundAt),
    )) {
      await queue.add(
        'followup_check',
        {
          pipeline: 'followup_check',
          conversationId: c.id,
          contactId: c.contactId,
          ...(c.campaignId ? { campaignId: c.campaignId } : {}),
        },
        {
          jobId: `followup_check:${c.id}`,
          attempts: 2,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    }
    if (conversations.length > 0) {
      logger.info({ count: conversations.length }, 'followup scheduler queued conversations');
    }
  };

  const handle = setInterval(() => void tick().catch((err) => {
    logger.warn({ err: (err as Error).message }, 'followup scheduler tick failed');
  }), INTERVAL_MS);
  void tick().catch((err) => {
    logger.warn({ err: (err as Error).message }, 'followup scheduler initial tick failed');
  });

  return {
    stop: async () => {
      stopping = true;
      clearInterval(handle);
      await queue.close().catch(() => undefined);
    },
  };
}
