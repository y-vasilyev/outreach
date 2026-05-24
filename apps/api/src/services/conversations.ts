import { getPrisma, Prisma } from '@nosquare/db';
import { Errors, extractOpenerVariant } from '@nosquare/shared';
import type { z } from 'zod';
import type { ConversationFiltersZ } from '@nosquare/shared';
import { getQueues } from '../queues.js';
import { emitToRoom } from '../realtime/io.js';
import { getAgentRunner } from './agents.js';

type Filters = z.infer<typeof ConversationFiltersZ>;

function readOutreachStartAt(meta: unknown): string | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const v = (meta as { outreachStartAt?: unknown }).outreachStartAt;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

async function assertOutboundSafe(input: { conversationId: string; text: string }) {
  const prisma = getPrisma();
  const conv = await prisma.conversation.findUnique({
    where: { id: input.conversationId },
    include: {
      contact: { include: { channel: true } },
      campaign: true,
    },
  });
  if (!conv) throw Errors.notFound('conversation', input.conversationId);

  const safety = await getAgentRunner().run<{
    allow: boolean;
    reasons: string[];
    risk_score: number;
    rewrite_hint?: string;
  }>(
    'safety_filter',
    {
      draft: input.text,
      channel_analysis: conv.contact.channel?.analysis ?? {},
      contact: { id: conv.contact.id, value: conv.contact.value, role: conv.contact.roleGuess },
      campaign: conv.campaign
        ? { name: conv.campaign.name, goal_text: conv.campaign.goalText, value_prop: conv.campaign.valueProp }
        : {},
    },
    {
      conversationId: conv.id,
      contactId: conv.contactId,
      ...(conv.campaignId ? { campaignId: conv.campaignId } : {}),
    },
  );
  if (!safety.allow) {
    throw Errors.badRequest('SafetyFilter blocked outbound message', {
      reasons: safety.reasons,
      risk_score: safety.risk_score,
      rewrite_hint: safety.rewrite_hint,
    });
  }
  return conv;
}

export const conversationsService = {
  async list(filters: Filters & { limit?: number }) {
    const prisma = getPrisma();
    const rows = await prisma.conversation.findMany({
      where: {
        ...(filters.status && { status: filters.status }),
        ...(filters.mode && { mode: filters.mode }),
        ...(filters.campaignId && { campaignId: filters.campaignId }),
        ...(filters.assignedOperatorId && { assignedOperatorId: filters.assignedOperatorId }),
      },
      include: {
        contact: { include: { channel: { select: { handle: true, platform: true, title: true } } } },
        tgAccount: { select: { id: true, label: true } },
        campaign: { select: { id: true, name: true } },
      },
      orderBy: [{ lastInboundAt: 'desc' }, { createdAt: 'desc' }],
      take: filters.limit ?? 100,
    });

    if (rows.length === 0) return rows;

    // Per-conversation aggregates (latest message + pending suggestions count)
    // — kept in two grouped queries instead of N+1 lookups.
    const ids = rows.map((r) => r.id);
    const [lastMessages, pendingSuggestions] = await Promise.all([
      prisma.message.findMany({
        where: { conversationId: { in: ids } },
        orderBy: { createdAt: 'desc' },
        distinct: ['conversationId'],
        select: { conversationId: true, text: true, createdAt: true, direction: true },
      }),
      prisma.suggestion.groupBy({
        by: ['conversationId'],
        where: { conversationId: { in: ids }, status: 'pending' },
        _count: { _all: true },
      }),
    ]);

    const lastByConv = new Map<string, (typeof lastMessages)[number]>();
    for (const m of lastMessages) lastByConv.set(m.conversationId, m);
    const pendingByConv = new Map<string, number>();
    for (const s of pendingSuggestions) pendingByConv.set(s.conversationId, s._count._all);

    return rows.map((r) => {
      const last = lastByConv.get(r.id);
      return {
        ...r,
        lastMessageText: last?.text ?? null,
        lastMessageAt: last?.createdAt?.toISOString() ?? null,
        pendingSuggestions: pendingByConv.get(r.id) ?? 0,
      };
    });
  },

  async get(id: string) {
    const prisma = getPrisma();
    const c = await prisma.conversation.findUnique({
      where: { id },
      include: {
        contact: { include: { channel: true } },
        tgAccount: true,
        campaign: true,
      },
    });
    if (!c) throw Errors.notFound('conversation', id);
    return c;
  },

  async getMessages(id: string, limit = 200) {
    const prisma = getPrisma();
    return prisma.message.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  },

  async getSuggestions(id: string) {
    const prisma = getPrisma();
    const rows = await prisma.suggestion.findMany({
      where: { conversationId: id, status: 'pending' },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    // Prisma serialises Decimal columns as strings on the wire, but the
    // UI's ConfBar expects a number (it renders the bar width arithmetically).
    return rows.map((r) => ({ ...r, score: Number(r.score) }));
  },

  async setMode(id: string, mode: 'auto' | 'semi_auto' | 'assisted' | 'manual') {
    const prisma = getPrisma();
    // Operator-driven mode change clears the latest gate snapshot — once
    // the operator decides what mode this conversation should be in, any
    // prior "AI handed off" verdict is no longer relevant. The on_inbound
    // pipeline will write a fresh decision on the next inbound if the new
    // mode is `semi_auto` or `auto`. Use Prisma.JsonNull to set the JSON
    // column to SQL NULL (TS2322 otherwise — Prisma distinguishes
    // database NULL from a JSON `null` value).
    const c = await prisma.conversation.update({
      where: { id },
      data: { mode, qualityDecision: Prisma.JsonNull },
    });
    emitToRoom(`conversation:${id}`, { type: 'mode.changed', conversationId: id, mode });
    return c;
  },

  async setStatus(id: string, status: 'active' | 'paused' | 'done' | 'failed') {
    const prisma = getPrisma();
    return prisma.conversation.update({ where: { id }, data: { status } });
  },

  async sendOperatorMessage(input: {
    conversationId: string;
    text: string;
    fromSuggestionId?: string;
    scheduledAt?: string;
    operatorId: string;
    bypassSafety?: boolean;
    /**
     * Opener variantKey to persist on the outbound `Message.openerVariant`.
     * Normally inferred from `fromSuggestionId` (see below); the explicit
     * argument exists so `approveSuggestion` can reuse the meta it has
     * already loaded without a second DB roundtrip. When BOTH are
     * present the explicit value wins. ab-opener-variants change.
     */
    openerVariant?: string;
  }) {
    const prisma = getPrisma();
    const conv = input.bypassSafety
      ? await prisma.conversation.findUnique({ where: { id: input.conversationId } })
      : await assertOutboundSafe({ conversationId: input.conversationId, text: input.text });
    if (!conv) throw Errors.notFound('conversation', input.conversationId);

    // Resolve the opener variantKey if not explicitly supplied. The
    // generic send-from-suggestion route (`POST
    // /conversations/:id/messages` with `fromSuggestionId`) skips
    // `approveSuggestion` and lands here directly, so we must do the
    // meta lookup ourselves to preserve attribution. `extractOpenerVariant`
    // gates on agentName + meta shape so non-opener suggestions never
    // leak a variantKey onto the message column.
    //
    // SECURITY: the lookup MUST be scoped to the current conversation —
    // a caller supplying a `fromSuggestionId` from a different
    // conversation would otherwise copy that suggestion's opener
    // variant AND get its `status` flipped to `sent` below. The findFirst
    // (id + conversationId) call returns null in that mismatch case;
    // we then refuse the request rather than silently dropping the
    // suggestion link. ab-opener-variants change.
    let resolvedOpenerVariant: string | null = input.openerVariant ?? null;
    if (input.fromSuggestionId) {
      const sug = await prisma.suggestion.findFirst({
        where: { id: input.fromSuggestionId, conversationId: input.conversationId },
        select: { agentName: true, meta: true },
      });
      if (!sug) {
        throw Errors.notFound('suggestion', input.fromSuggestionId);
      }
      if (!resolvedOpenerVariant) {
        resolvedOpenerVariant = extractOpenerVariant(sug);
      }
    }

    const message = await prisma.message.create({
      data: {
        conversationId: input.conversationId,
        direction: 'out_',
        sender: 'operator',
        text: input.text,
        status: 'pending',
        suggestionId: input.fromSuggestionId ?? null,
        operatorId: input.operatorId,
        ...(resolvedOpenerVariant ? { openerVariant: resolvedOpenerVariant } : {}),
      },
    });

    if (input.fromSuggestionId) {
      // Same conversation-scoped guard as above: `updateMany` is a no-op
      // when the suggestion doesn't belong to this conversation (the
      // `findFirst` above would already have thrown in that case, but
      // belt-and-braces against future refactors).
      await prisma.suggestion.updateMany({
        where: { id: input.fromSuggestionId, conversationId: input.conversationId },
        data: { status: 'sent' },
      });
    }

    const delay = input.scheduledAt
      ? Math.max(0, new Date(input.scheduledAt).getTime() - Date.now())
      : 0;

    const queues = getQueues();
    await queues.tgSend.add(
      'send',
      {
        messageId: message.id,
        conversationId: conv.id,
        tgAccountId: conv.tgAccountId,
      },
      delay > 0 ? { delay } : undefined,
    );

    return message;
  },

  async approveSuggestion(
    suggestionId: string,
    operatorId: string,
    overrideText?: string,
    scheduledAt?: string,
  ) {
    const prisma = getPrisma();
    const s = await prisma.suggestion.findUnique({
      where: { id: suggestionId },
      include: { conversation: { select: { meta: true } } },
    });
    if (!s) throw Errors.notFound('suggestion', suggestionId);
    const text = overrideText ?? s.text;
    await assertOutboundSafe({ conversationId: s.conversationId, text });
    if (overrideText && overrideText !== s.text) {
      await prisma.suggestion.update({
        where: { id: s.id },
        data: { status: 'edited', text: overrideText },
      });
    }
    // Carry the opener variantKey from the source suggestion onto the
    // outbound Message — same path as `tryAutoApprove`. The helper gates
    // on `agentName` and the meta shape, so a non-opener suggestion never
    // leaks a variantKey to the message column. ab-opener-variants change.
    const openerVariant = extractOpenerVariant({ agentName: s.agentName, meta: s.meta });
    return this.sendOperatorMessage({
      conversationId: s.conversationId,
      text,
      fromSuggestionId: s.id,
      scheduledAt: scheduledAt ?? readOutreachStartAt(s.conversation.meta),
      operatorId,
      bypassSafety: true,
      ...(openerVariant ? { openerVariant } : {}),
    });
  },

  async rejectSuggestion(suggestionId: string) {
    const prisma = getPrisma();
    return prisma.suggestion.update({
      where: { id: suggestionId },
      data: { status: 'rejected' },
    });
  },

  /**
   * Re-trigger AI suggestion generation for an existing conversation. Picks
   * the right pipeline based on conversation state:
   *   - Conversation has zero messages on it → `outreach_first_message`
   *     (OpeningComposer): we haven't reached out yet.
   *   - Anything else → `on_inbound` (ReplyComposer): once a single message
   *     exists, the opener phase is over. on_inbound itself handles the
   *     "latest message is outbound, nothing new to reply to" case by
   *     short-circuiting on `if (!last) return skipped: 'no inbound'`.
   *
   * Previously this checked "is the latest message inbound?" and fell back
   * to opener whenever the latest was outbound, which re-fired the
   * opening_composer over and over after the operator's own replies.
   *
   * Marks any existing `pending` suggestions as `expired` so the inbox
   * doesn't show stale ones from before the rerun.
   */
  async regenerateSuggestions(conversationId: string): Promise<{
    ok: true;
    pipeline: 'on_inbound' | 'outreach_first_message';
    expiredCount: number;
  }> {
    const prisma = getPrisma();
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true, contactId: true, campaignId: true },
    });
    if (!conv) throw Errors.notFound('conversation', conversationId);

    const messageCount = await prisma.message.count({ where: { conversationId } });
    const pipeline: 'on_inbound' | 'outreach_first_message' =
      messageCount === 0 ? 'outreach_first_message' : 'on_inbound';

    // Expire any stale pending suggestions so the inbox doesn't show old +
    // new mixed.
    const expired = await prisma.suggestion.updateMany({
      where: { conversationId, status: 'pending' },
      data: { status: 'expired' },
    });

    const queues = getQueues();
    await queues.agentRun.add(pipeline, {
      pipeline,
      conversationId,
      contactId: conv.contactId,
      ...(conv.campaignId ? { campaignId: conv.campaignId } : {}),
    });

    return { ok: true, pipeline, expiredCount: expired.count };
  },
};
