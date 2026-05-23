import { UnrecoverableError, Worker } from 'bullmq';
import { isAppError } from '@nosquare/shared/errors';

import { getRedis } from '../redis.js';
import { TgSendJobZ, QueueNames } from '@nosquare/shared';
import { getPrisma } from '@nosquare/db';
import { getTgClient } from '../services/tg-client.js';
import { logger } from '../logger.js';
import { publishRealtime } from '../services/realtime-emit.js';
import { rolloverTgAccountDailyCounters } from '../services/tg-account-limits.js';

function jitterMs() {
  return 30_000 + Math.floor(Math.random() * 150_000);
}

/**
 * Mark all the rows around a permanently-undeliverable send so the
 * operator UI shows the dead conversation immediately and the campaign
 * dispatcher stops trying to reach this contact.
 *
 * Called only on `TG_PEER_FORBIDDEN` — i.e. CHAT_WRITE_FORBIDDEN /
 * USER_PRIVACY_RESTRICTED / USER_IS_BLOCKED / INPUT_USER_DEACTIVATED /
 * etc. The TG account itself is unaffected.
 */
async function markPeerUndeliverable(
  messageId: string,
  conversationId: string,
  contactId: string,
  reason: string,
): Promise<void> {
  const prisma = getPrisma();
  // Best-effort — every step is wrapped in its own try so a single DB
  // hiccup doesn't leave the row half-updated.
  try {
    await prisma.message.update({
      where: { id: messageId },
      data: { status: 'failed' },
    });
  } catch (e) {
    logger.warn({ err: (e as Error).message, messageId }, 'mark message failed: db error');
  }
  try {
    await prisma.contact.update({
      where: { id: contactId },
      data: { reachability: 'unreachable', status: 'blocked' },
    });
  } catch (e) {
    logger.warn({ err: (e as Error).message, contactId }, 'mark contact unreachable: db error');
  }
  try {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { status: 'failed' },
    });
  } catch (e) {
    logger.warn(
      { err: (e as Error).message, conversationId },
      'mark conversation failed: db error',
    );
  }
  try {
    await publishRealtime(`conversation:${conversationId}`, {
      type: 'agent.failed',
      conversationId,
      agentName: 'tg_send',
      code: 'TG_PEER_FORBIDDEN',
      reason: `Сообщение не доставлено: ${reason}. Контакт помечен как недоступный.`,
    });
    await publishRealtime(`conversation:${conversationId}`, {
      type: 'status.changed',
      conversationId,
      status: 'failed',
    });
  } catch (e) {
    logger.warn(
      { err: (e as Error).message, conversationId },
      'mark peer undeliverable: realtime emit failed',
    );
  }
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
      await rolloverTgAccountDailyCounters([tgAccountId]);

      // Resolve and persist the recipient's TG profile on the first send.
      // Two reasons this matters:
      //   1. tg-listen matches inbound replies via `Contact.tgUserId`;
      //      without this we either drop the reply or attribute it to the
      //      wrong contact.
      //   2. The opener / reply LLM pipelines read first/last name off the
      //      contact, so the prompt no longer hallucinates a name.
      // We only resolve for TG-reachable contact types and skip if already
      // populated.
      if (!conv.contact.tgUserId && (conv.contact.type === 'tg_username' || conv.contact.type === 'tg_link')) {
        try {
          const resolved = await handle.resolveUser(target);
          await prisma.contact.update({
            where: { id: conv.contact.id },
            data: {
              tgUserId: resolved.id,
              tgUsername: resolved.username ?? null,
              tgFirstName: resolved.firstName ?? null,
              tgLastName: resolved.lastName ?? null,
            },
          });
        } catch (err) {
          // Non-fatal: still try to send. Worst case we'll have to fall
          // back to handle-based matching on inbound (which we don't, so
          // the operator will need to pick up the conversation manually).
          logger.warn(
            { err: (err as Error).message, contactId: conv.contact.id },
            'tg-send: resolveUser failed; sending without profile data',
          );
        }
      }

      let r: Awaited<ReturnType<typeof handle.sendMessage>>;
      try {
        r = await handle.sendMessage(target, message.text);
      } catch (err) {
        // Permanent peer-level rejection (CHAT_WRITE_FORBIDDEN /
        // USER_PRIVACY_RESTRICTED / USER_IS_BLOCKED / INPUT_USER_DEACTIVATED
        // / PEER_ID_INVALID / etc.). The session is FINE — only this
        // recipient is undeliverable. Mark the contact + conversation +
        // message dead, ping the operator UI, and stop BullMQ from
        // retrying via UnrecoverableError. Do NOT throw a regular Error
        // — that would re-queue and waste attempts.
        if (isAppError(err) && err.code === 'TG_PEER_FORBIDDEN') {
          const reason = err.message.replace(/^TG:\s*/, '');
          logger.warn(
            {
              event: 'tg-send.peerForbidden',
              messageId,
              conversationId,
              contactId: conv.contact.id,
              reason,
            },
            'tg-send: recipient is unreachable — marking and stopping retries',
          );
          await markPeerUndeliverable(messageId, conversationId, conv.contact.id, reason);
          throw new UnrecoverableError(`TG_PEER_FORBIDDEN: ${reason}`);
        }
        // Anything else — let the existing failure handler set status=failed
        // and BullMQ retry per its policy.
        throw err;
      }

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
        // Don't double-write status=failed for peer-permanent failures —
        // the inline handler already marked the row + contact + conv. The
        // UnrecoverableError is preserved here; we just need the generic
        // last-resort marking for transient/unknown failures.
        if (err instanceof UnrecoverableError) return;
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
