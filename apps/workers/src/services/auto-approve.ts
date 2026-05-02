import { getPrisma } from '@nosquare/db';
import { Queue } from 'bullmq';
import { QueueNames } from '@nosquare/shared';
import { getRedis } from '../redis.js';
import { publishRealtime } from './realtime-emit.js';
import { logger } from '../logger.js';

let _tgSendQueue: Queue | undefined;
function tgSendQueue(): Queue {
  if (!_tgSendQueue) {
    _tgSendQueue = new Queue(QueueNames.tgSend, { connection: getRedis() });
  }
  return _tgSendQueue;
}

export interface AutoApproveContext {
  conversationId: string;
  suggestionId: string;
  text: string;
  /** Score 0..1: confidence-of-fit (1 - risk_score). */
  score: number;
  /** Optional exact start time. Used for opening messages, not replies. */
  scheduledAt?: string;
  /** Optional random delay window for first-touch outreach. */
  jitterMaxMs?: number;
}

/**
 * Auto-approval threshold. Suggestions below this are left pending for the
 * operator. 0.8 = the SafetyFilter must be confident (risk_score ≤ 0.2).
 */
const AUTO_APPROVE_MIN_SCORE = 0.8;

function computeDelayMs(ctx: AutoApproveContext): number {
  const jitter = ctx.jitterMaxMs && ctx.jitterMaxMs > 0
    ? Math.floor(Math.random() * ctx.jitterMaxMs)
    : 0;
  if (!ctx.scheduledAt) return jitter;

  const at = new Date(ctx.scheduledAt).getTime();
  if (!Number.isFinite(at)) return jitter;
  return Math.max(0, at - Date.now()) + jitter;
}

/**
 * Fire-and-forget helper used by both campaign-dispatcher (for opening
 * suggestions) and agent-run (for reply suggestions). When the conversation
 * is in `auto` mode and the suggestion clears the safety threshold, we
 * approve it immediately: bind the suggestion to a freshly-queued outbound
 * message and let `tg-send` deliver it via GramJS — same code path as a
 * human-approved send.
 *
 * Returns `false` when nothing happened (mode != auto, score too low,
 * conversation missing) so the caller can stay quiet.
 */
export async function tryAutoApprove(ctx: AutoApproveContext): Promise<boolean> {
  if (ctx.score < AUTO_APPROVE_MIN_SCORE) return false;

  const prisma = getPrisma();
  const conv = await prisma.conversation.findUnique({
    where: { id: ctx.conversationId },
    select: { id: true, mode: true, tgAccountId: true, status: true },
  });
  if (!conv) return false;
  if (conv.mode !== 'auto') return false;
  if (conv.status !== 'active') return false;

  // Mark the suggestion as approved (so the inbox doesn't show it as
  // pending) and create a pending outbound message bound to it. tg-send
  // takes it from there, including jitter and FloodGuard awareness.
  const message = await prisma.$transaction(async (tx) => {
    await tx.suggestion.update({
      where: { id: ctx.suggestionId },
      data: { status: 'approved' },
    });
    return tx.message.create({
      data: {
        conversationId: ctx.conversationId,
        direction: 'out_',
        sender: 'ai',
        text: ctx.text,
        status: 'pending',
        suggestionId: ctx.suggestionId,
      },
    });
  });

  const delay = computeDelayMs(ctx);
  await tgSendQueue().add(
    'send',
    {
      messageId: message.id,
      conversationId: ctx.conversationId,
      tgAccountId: conv.tgAccountId,
    },
    delay > 0 ? { delay } : undefined,
  );

  await publishRealtime(`conversation:${ctx.conversationId}`, {
    type: 'suggestion.approved',
    conversationId: ctx.conversationId,
    suggestionId: ctx.suggestionId,
    auto: true,
  });

  logger.info(
    {
      conversationId: ctx.conversationId,
      suggestionId: ctx.suggestionId,
      score: ctx.score,
      delay,
      scheduledAt: ctx.scheduledAt,
    },
    'auto-approved suggestion in auto-mode conversation',
  );
  return true;
}
