import { getPrisma } from '@nosquare/db';
import {
  WARMUP_TOP_STAGE,
  daysSince,
  nextPromotionCandidate,
} from '@nosquare/shared';
import { logger } from '../logger.js';

/**
 * Hourly reconciler that moves `tg_account.warmup_stage` forward when the
 * dwell-time + reply-rate gates pass. Never demotes — that's the
 * reply-rate-guard's job (separate concern).
 *
 * Reply-rate is computed across the conversations owned by the account,
 * since `warmupStartedAt`. We deliberately use a coarse window (everything
 * since warmup started, not last-N-sends) so a healthy account that's been
 * running for weeks doesn't get held back by a recent bad slice.
 */
const TICK_MS = 60 * 60 * 1000; // 1h

async function evaluateReplyRate(
  tgAccountId: string,
  since: Date,
): Promise<{ sent: number; replied: number; replyRate: number }> {
  const prisma = getPrisma();
  // Sent = our outbound messages that actually left the building.
  const sent = await prisma.message.count({
    where: {
      conversation: { tgAccountId },
      direction: 'out_',
      status: 'sent',
      sentAt: { gte: since },
    },
  });
  if (sent === 0) return { sent: 0, replied: 0, replyRate: 0 };
  // Replied = conversations owned by this account that received an inbound
  // from the contact since warmup started. One reply per conversation
  // counts — a chatty contact doesn't inflate the rate.
  const repliedConvs = await prisma.conversation.findMany({
    where: {
      tgAccountId,
      messages: {
        some: {
          direction: 'in_',
          sender: 'contact',
          createdAt: { gte: since },
        },
      },
    },
    select: { id: true },
  });
  const replied = repliedConvs.length;
  return { sent, replied, replyRate: replied / sent };
}

async function promoteTick(): Promise<void> {
  const prisma = getPrisma();
  const candidates = await prisma.tgAccount.findMany({
    where: {
      warmupStartedAt: { not: null },
      warmupStage: { lt: WARMUP_TOP_STAGE },
    },
    select: {
      id: true,
      label: true,
      warmupStage: true,
      warmupStartedAt: true,
    },
  });
  if (candidates.length === 0) return;

  const now = new Date();
  let promoted = 0;
  for (const a of candidates) {
    const target = nextPromotionCandidate(a.warmupStage, a.warmupStartedAt, now);
    if (!target) continue;

    // Reply-rate gate. Skipped when send count is below threshold (not
    // enough data yet — but day dwell IS met, see nextPromotionCandidate).
    const stats = await evaluateReplyRate(a.id, a.warmupStartedAt!);
    if (stats.sent >= target.minSendsForReplyRate && stats.replyRate < target.minReplyRate) {
      logger.info(
        {
          tgAccountId: a.id,
          label: a.label,
          stage: a.warmupStage,
          target: target.stage,
          sent: stats.sent,
          replied: stats.replied,
          replyRate: stats.replyRate.toFixed(3),
          minReplyRate: target.minReplyRate,
        },
        'warmup: promotion frozen by reply-rate gate',
      );
      continue;
    }

    await prisma.tgAccount.update({
      where: { id: a.id },
      data: { warmupStage: target.stage },
    });
    promoted++;
    logger.info(
      {
        tgAccountId: a.id,
        label: a.label,
        from: a.warmupStage,
        to: target.stage,
        daysSinceStart: daysSince(a.warmupStartedAt, now),
        sent: stats.sent,
        replyRate: stats.replyRate.toFixed(3),
      },
      'warmup: promoted',
    );
  }
  if (promoted > 0) {
    logger.info({ promoted }, 'warmup-promoter: tick done');
  }
}

export function startWarmupPromoter(): { stop: () => void } {
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    promoteTick().catch((err) => {
      logger.warn({ err: (err as Error).message }, 'warmup-promoter: tick failed');
    });
  };
  // Initial tick after a 15s delay to let DB connect.
  setTimeout(tick, 15_000);
  const timer = setInterval(tick, TICK_MS);
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
