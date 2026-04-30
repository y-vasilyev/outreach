import { getPrisma } from '@nosquare/db';
import { Errors } from '@nosquare/shared';
import type { z } from 'zod';
import type { ConversationFiltersZ } from '@nosquare/shared';
import { getQueues } from '../queues.js';
import { emitToRoom } from '../realtime/io.js';

type Filters = z.infer<typeof ConversationFiltersZ>;

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
    return prisma.suggestion.findMany({
      where: { conversationId: id, status: 'pending' },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
  },

  async setMode(id: string, mode: 'auto' | 'assisted' | 'manual') {
    const prisma = getPrisma();
    const c = await prisma.conversation.update({ where: { id }, data: { mode } });
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
    operatorId: string;
  }) {
    const prisma = getPrisma();
    const conv = await prisma.conversation.findUnique({
      where: { id: input.conversationId },
    });
    if (!conv) throw Errors.notFound('conversation', input.conversationId);

    const message = await prisma.message.create({
      data: {
        conversationId: input.conversationId,
        direction: 'out_',
        sender: 'operator',
        text: input.text,
        status: 'pending',
        suggestionId: input.fromSuggestionId ?? null,
        operatorId: input.operatorId,
      },
    });

    if (input.fromSuggestionId) {
      await prisma.suggestion.update({
        where: { id: input.fromSuggestionId },
        data: { status: 'sent' },
      });
    }

    const queues = getQueues();
    await queues.tgSend.add('send', {
      messageId: message.id,
      conversationId: conv.id,
      tgAccountId: conv.tgAccountId,
    });

    return message;
  },

  async approveSuggestion(suggestionId: string, operatorId: string, overrideText?: string) {
    const prisma = getPrisma();
    const s = await prisma.suggestion.findUnique({ where: { id: suggestionId } });
    if (!s) throw Errors.notFound('suggestion', suggestionId);
    const text = overrideText ?? s.text;
    if (overrideText && overrideText !== s.text) {
      await prisma.suggestion.update({
        where: { id: s.id },
        data: { status: 'edited', text: overrideText },
      });
    }
    return this.sendOperatorMessage({
      conversationId: s.conversationId,
      text,
      fromSuggestionId: s.id,
      operatorId,
    });
  },

  async rejectSuggestion(suggestionId: string) {
    const prisma = getPrisma();
    return prisma.suggestion.update({
      where: { id: suggestionId },
      data: { status: 'rejected' },
    });
  },
};
