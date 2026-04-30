import { Worker } from 'bullmq';
import { getRedis } from '../redis.js';
import { TgSendJobZ, QueueNames } from '@nosquare/shared';
import { getPrisma } from '@nosquare/db';
import { getTgClient } from '../services/tg-client.js';
import { logger } from '../logger.js';
import { publishRealtime } from '../services/realtime-emit.js';

function jitterMs() {
  return 30_000 + Math.floor(Math.random() * 150_000);
}

export function startTgSendWorker() {
  const worker = new Worker(
    QueueNames.tgSend,
    async (job) => {
      const { messageId, conversationId, tgAccountId } = TgSendJobZ.parse(job.data);
      const prisma = getPrisma();
      const message = await prisma.message.findUnique({ where: { id: messageId } });
      if (!message) throw new Error(`message ${messageId} not found`);
      if (message.status !== 'pending') {
        logger.info({ messageId, status: message.status }, 'message not pending; skipping');
        return { ok: true, skipped: true };
      }

      await prisma.message.update({
        where: { id: messageId },
        data: { status: 'sending' },
      });

      const conv = await prisma.conversation.findUnique({
        where: { id: conversationId },
        include: { contact: true },
      });
      if (!conv) throw new Error(`conversation ${conversationId} not found`);

      const target = conv.contact.value;

      const tg = getTgClient();
      if (!tg) {
        await prisma.message.update({
          where: { id: messageId },
          data: { status: 'failed' },
        });
        throw new Error('TG client not configured (TG_API_ID/HASH missing)');
      }

      // small randomized delay
      await new Promise((r) => setTimeout(r, Math.min(5000, jitterMs())));

      const handle = await tg.for(tgAccountId);
      const r = await handle.sendMessage(target, message.text);

      await prisma.message.update({
        where: { id: messageId },
        data: { status: 'sent', tgMsgId: r.tgMsgId, sentAt: new Date(r.sentAt) },
      });

      await prisma.conversation.update({
        where: { id: conversationId },
        data: { lastOutboundAt: new Date() },
      });

      await prisma.tgAccount.update({
        where: { id: tgAccountId },
        data: { sentTodayMsg: { increment: 1 } },
      });

      await publishRealtime(`conversation:${conversationId}`, {
        type: 'message.new',
        conversationId,
        message: {
          id: message.id,
          direction: 'out',
          sender: message.sender as 'contact' | 'ai' | 'operator' | 'system',
          text: message.text,
          createdAt: message.createdAt.toISOString(),
        },
      });

      return { ok: true };
    },
    { connection: getRedis(), concurrency: 2 },
  );

  worker.on('failed', async (job, err) => {
    logger.error({ jobId: job?.id, err: err?.message }, 'tg-send failed');
    if (job?.data) {
      try {
        const { messageId } = TgSendJobZ.parse(job.data);
        await getPrisma().message.update({
          where: { id: messageId },
          data: { status: 'failed' },
        });
      } catch {
        // best effort
      }
    }
  });
  return worker;
}
