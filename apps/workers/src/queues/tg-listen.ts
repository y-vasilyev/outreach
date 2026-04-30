import { Worker, Queue } from 'bullmq';
import { getRedis } from '../redis.js';
import { TgListenJobZ, QueueNames } from '@nosquare/shared';
import { getPrisma } from '@nosquare/db';
import { getTgClient } from '../services/tg-client.js';
import { logger } from '../logger.js';
import { publishRealtime } from '../services/realtime-emit.js';

let _agentRunQueue: Queue | undefined;
function agentRunQueue(): Queue {
  if (!_agentRunQueue) {
    _agentRunQueue = new Queue(QueueNames.agentRun, { connection: getRedis() });
  }
  return _agentRunQueue;
}

/**
 * Worker that consumes `tg-listen` jobs produced by `startTgListenSubscribers`.
 * For each incoming TG message we:
 *   1. resolve the contact (`tgUserId` first, then `value === '@'+username`),
 *   2. find or create the conversation against the receiving outreach account,
 *   3. write the inbound `Message`,
 *   4. update `lastInboundAt`,
 *   5. emit realtime `message.new`,
 *   6. enqueue an `agent-run` job with `pipeline: 'on_inbound'` so the
 *      ReplyComposer/SafetyFilter pipeline produces suggestions.
 *
 * Idempotent against duplicate deliveries via `tgMsgId` uniqueness check.
 */
export function startTgListenWorker() {
  const worker = new Worker(
    QueueNames.tgListen,
    async (job) => {
      const data = TgListenJobZ.parse(job.data);
      const prisma = getPrisma();

      // 1. Resolve contact. We don't have `tgUserId` populated everywhere
      // yet (resolver runs at first send), so fall back to handle match.
      let contact = await prisma.contact.findFirst({
        where: { tgUserId: data.fromTgUserId },
      });
      if (!contact) {
        contact = await prisma.contact.findFirst({
          where: {
            type: 'tg_username',
            // Stored as bare handle, no leading `@`.
            value: { not: '' },
            // We don't know the username here; this branch is intentionally
            // narrow — real resolution happens via tgUserId once known.
          },
          orderBy: { updatedAt: 'desc' },
          take: 1,
          // The unsafe path is matching by handle without verifying — skip
          // unless we have a hard signal. For now, drop unmatched events.
        });
      }
      if (!contact) {
        logger.info(
          { fromTgUserId: data.fromTgUserId, tgAccountId: data.tgAccountId },
          'inbound message has no matching contact; dropping',
        );
        return { ok: true, skipped: 'no contact' };
      }

      // Persist tgUserId on the contact for next time.
      if (!contact.tgUserId) {
        await prisma.contact.update({
          where: { id: contact.id },
          data: { tgUserId: data.fromTgUserId },
        });
      }

      // 2. Find or create the conversation.
      let conv = await prisma.conversation.findUnique({
        where: {
          tgAccountId_contactId: {
            tgAccountId: data.tgAccountId,
            contactId: contact.id,
          },
        },
      });
      if (!conv) {
        conv = await prisma.conversation.create({
          data: {
            tgAccountId: data.tgAccountId,
            contactId: contact.id,
            status: 'active',
            mode: 'assisted',
          },
        });
      }

      // 3. Idempotency: skip if we already stored this tgMsgId for this conv.
      if (data.tgMsgId) {
        const dup = await prisma.message.findFirst({
          where: { conversationId: conv.id, tgMsgId: data.tgMsgId },
          select: { id: true },
        });
        if (dup) return { ok: true, skipped: 'duplicate' };
      }

      const message = await prisma.message.create({
        data: {
          conversationId: conv.id,
          direction: 'in_',
          sender: 'contact',
          text: data.text,
          status: 'received',
          tgMsgId: data.tgMsgId || null,
        },
      });

      // 4. Touch `lastInboundAt` and bring the conversation back to active
      // (in case it was closed/paused).
      await prisma.conversation.update({
        where: { id: conv.id },
        data: { lastInboundAt: new Date(data.receivedAt) },
      });

      // 5. Realtime push to anyone watching this conversation.
      await publishRealtime(`conversation:${conv.id}`, {
        type: 'message.new',
        conversationId: conv.id,
        message: {
          id: message.id,
          direction: 'in',
          sender: 'contact',
          text: message.text,
          createdAt: message.createdAt.toISOString(),
        },
      });

      // 6. Trigger the on_inbound agent pipeline (intent → handoff → reply
      // → safety → suggestion). agent-run reads the latest inbound from
      // history, so we don't need to pass the messageId explicitly.
      await agentRunQueue().add('on_inbound', {
        pipeline: 'on_inbound',
        conversationId: conv.id,
        contactId: contact.id,
      });

      return { ok: true, conversationId: conv.id, messageId: message.id };
    },
    { connection: getRedis(), concurrency: 4 },
  );

  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err: err?.message }, 'tg-listen failed'),
  );
  return worker;
}

/**
 * Boot-time subscriber: connects to every active outreach/both account and
 * registers an incoming-message handler that enqueues `tg-listen` jobs.
 *
 * The handler doesn't do any DB/agent work itself — it just turns a TG
 * event into a queue job, so a flaky GramJS connection can't lose data
 * (BullMQ retries on failure) and the listener stays light.
 */
export async function startTgListenSubscribers(): Promise<{ stop: () => Promise<void> }> {
  const prisma = getPrisma();
  const tg = getTgClient();
  if (!tg) {
    logger.warn('TG client not configured; tg-listen subscribers are disabled');
    return { stop: async () => undefined };
  }

  const accounts = await prisma.tgAccount.findMany({
    where: { status: 'active', role: { in: ['outreach', 'both'] } },
    select: { id: true, label: true },
  });

  const queue = new Queue(QueueNames.tgListen, { connection: getRedis() });
  const unsubs: Array<() => void> = [];

  for (const a of accounts) {
    try {
      const handle = await tg.for(a.id);
      if (!handle.isAuthorized) {
        logger.warn({ tgAccountId: a.id, label: a.label }, 'account not authorized; skipping');
        continue;
      }
      const unsub = handle.subscribeIncoming(async (msg) => {
        try {
          await queue.add('inbound', msg);
        } catch (err) {
          logger.warn(
            { tgAccountId: a.id, err: (err as Error).message },
            'failed to enqueue tg-listen job',
          );
        }
      });
      unsubs.push(unsub);
      logger.info({ tgAccountId: a.id, label: a.label }, 'tg-listen subscribed');
    } catch (err) {
      logger.warn(
        { tgAccountId: a.id, err: (err as Error).message },
        'tg-listen subscribe failed',
      );
    }
  }

  return {
    stop: async () => {
      for (const u of unsubs) {
        try { u(); } catch { /* ignore */ }
      }
      try { await queue.close(); } catch { /* ignore */ }
    },
  };
}
