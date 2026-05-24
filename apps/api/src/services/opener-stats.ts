import { getPrisma } from '@nosquare/db';
import { Errors, type OpenerStatsRow } from '@nosquare/shared';

/**
 * Per-campaign opener-variant aggregator (ab-opener-variants change).
 *
 * Read-only — no LLM, no side effects, no audit. Caller is gated on
 * admin/operator/viewer role at the route layer.
 *
 * The math is intentionally simple (see design.md decisions 2 + 5):
 *   - `sent` = `count(Message)` where `direction='out_' AND status='sent'
 *      AND openerVariant=K AND conversation.campaignId=:id`.
 *   - `replied` = subset of those `sent` rows where the SAME conversation
 *     has at least one inbound `Message` with `createdAt > openerSentAt`
 *     and `createdAt ≤ openerSentAt + withinHours`.
 *   - `replyRate` = `replied / sent`, clamped to `[0, 1]` defensively.
 *
 * Implementation note: we do NOT use `$queryRaw` — the dataset is small
 * (one opener per conversation, ≤ a few thousand conversations per
 * campaign at this scale), so two Prisma calls + an in-memory join is
 * both clearer and easier to mock in tests. If/when this hot-paths
 * itself we can fold it into a single SQL with a LATERAL EXISTS subquery.
 */
export const openerStatsService = {
  async get(campaignId: string, withinHours: number): Promise<OpenerStatsRow[]> {
    const prisma = getPrisma();

    // Campaign existence check — yields the standard 404 shape.
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true },
    });
    if (!campaign) throw Errors.notFound('campaign', campaignId);

    // Pull the opener-tagged outbound messages for this campaign. We need
    // (variantKey, conversationId, sentAt) so we can look up replies in
    // the right per-conversation window. `sentAt` is set by tg-send when
    // the message actually went out — using it (rather than createdAt)
    // means a queued-but-not-yet-sent message doesn't double-bucket and
    // a delayed-due-to-flood message attributes replies to its real
    // send time.
    const openers = await prisma.message.findMany({
      where: {
        direction: 'out_',
        status: 'sent',
        openerVariant: { not: null },
        sentAt: { not: null },
        conversation: { campaignId },
      },
      select: {
        id: true,
        conversationId: true,
        openerVariant: true,
        sentAt: true,
      },
    });

    if (openers.length === 0) return [];

    // For every (conversationId, openerSentAt) pair, ask: is there at
    // least one inbound within the window? Done as a single findMany
    // scoped to the conversations of interest; we filter in-memory by
    // window because windows are per-opener (different sentAt values).
    const conversationIds = Array.from(
      new Set(openers.map((m) => m.conversationId)),
    );
    const windowMs = withinHours * 60 * 60 * 1000;
    // Bound the inbound query by the latest possible window so a
    // conversation with a months-old reply stream doesn't drag every
    // row into memory.
    const earliestOpener = openers.reduce<Date>(
      (acc, m) => (m.sentAt! < acc ? m.sentAt! : acc),
      openers[0]!.sentAt!,
    );
    const latestOpenerPlusWindow = new Date(
      openers.reduce<number>(
        (acc, m) => Math.max(acc, m.sentAt!.getTime() + windowMs),
        0,
      ),
    );

    const inbounds = await prisma.message.findMany({
      where: {
        direction: 'in_',
        conversationId: { in: conversationIds },
        createdAt: { gte: earliestOpener, lte: latestOpenerPlusWindow },
      },
      select: { conversationId: true, createdAt: true },
    });

    // Group inbounds by conversation for O(1) per-opener lookups.
    const inboundsByConv = new Map<string, Date[]>();
    for (const i of inbounds) {
      const arr = inboundsByConv.get(i.conversationId) ?? [];
      arr.push(i.createdAt);
      inboundsByConv.set(i.conversationId, arr);
    }

    // Walk every opener: count it under `sent[variantKey]`; if any inbound
    // for the same conversation falls in `(sentAt, sentAt + window]`,
    // also count under `replied[variantKey]`.
    const sent = new Map<string, number>();
    const replied = new Map<string, number>();

    for (const m of openers) {
      const key = m.openerVariant!;
      sent.set(key, (sent.get(key) ?? 0) + 1);

      const windowStart = m.sentAt!;
      const windowEnd = new Date(windowStart.getTime() + windowMs);
      const candidates = inboundsByConv.get(m.conversationId) ?? [];
      const hasReply = candidates.some(
        (t) => t > windowStart && t <= windowEnd,
      );
      if (hasReply) {
        replied.set(key, (replied.get(key) ?? 0) + 1);
      }
    }

    // Materialise the row set sorted by variantKey for stable presentation.
    const variantKeys = Array.from(sent.keys()).sort();
    return variantKeys.map((variantKey) => {
      const s = sent.get(variantKey) ?? 0;
      const r = replied.get(variantKey) ?? 0;
      // Clamp defensively; s > 0 always holds here because we materialised
      // from `sent.keys()`, but the clamp guards against future refactors.
      const rate = s > 0 ? Math.max(0, Math.min(1, r / s)) : 0;
      return { variantKey, sent: s, replied: r, replyRate: rate };
    });
  },
};
