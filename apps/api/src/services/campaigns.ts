import { getPrisma } from '@nosquare/db';
import { Errors } from '@nosquare/shared';
import type { z } from 'zod';
import type { CreateCampaignInputZ } from '@nosquare/shared';

import { getQueues } from '../queues.js';

type CreateInput = z.infer<typeof CreateCampaignInputZ>;

interface TargetFilterShape {
  platforms?: string[];
  roleGuess?: string[];
  languages?: string[];
  topics?: string[];
  tags?: string[];
  minConfidence?: number;
}

interface CampaignMetrics {
  sent: number;
  replies: number;
  replyRate: number;
  qualified: number;
}

export const campaignsService = {
  async list() {
    const prisma = getPrisma();
    const rows = await prisma.campaign.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { conversations: true } } },
    });
    if (rows.length === 0) return rows;

    const ids = rows.map((r) => r.id);
    // Aggregate metrics from conversations + messages. Cheap enough at this
    // scale; if it gets slow we'll move it into a materialised view.
    const [sentByConv, replyByConv, qualifiedByCamp] = await Promise.all([
      prisma.message.groupBy({
        by: ['conversationId'],
        where: {
          direction: 'out_',
          status: 'sent',
          conversation: { campaignId: { in: ids } },
        },
        _count: { _all: true },
      }),
      prisma.message.groupBy({
        by: ['conversationId'],
        where: {
          direction: 'in_',
          conversation: { campaignId: { in: ids } },
        },
        _count: { _all: true },
      }),
      prisma.conversation.groupBy({
        by: ['campaignId'],
        where: { campaignId: { in: ids }, status: 'done' },
        _count: { _all: true },
      }),
    ]);

    // Sent/reply counts are per-conversation; we need them per-campaign.
    const convIds = new Set<string>([
      ...sentByConv.map((c) => c.conversationId),
      ...replyByConv.map((c) => c.conversationId),
    ]);
    const conv = convIds.size
      ? await prisma.conversation.findMany({
          where: { id: { in: [...convIds] } },
          select: { id: true, campaignId: true },
        })
      : [];
    const convToCampaign = new Map<string, string | null>();
    for (const c of conv) convToCampaign.set(c.id, c.campaignId);

    const sentByCamp = new Map<string, number>();
    const replyByCamp = new Map<string, number>();
    for (const r of sentByConv) {
      const cid = convToCampaign.get(r.conversationId);
      if (!cid) continue;
      sentByCamp.set(cid, (sentByCamp.get(cid) ?? 0) + r._count._all);
    }
    for (const r of replyByConv) {
      const cid = convToCampaign.get(r.conversationId);
      if (!cid) continue;
      replyByCamp.set(cid, (replyByCamp.get(cid) ?? 0) + r._count._all);
    }
    const qualifiedMap = new Map<string, number>();
    for (const r of qualifiedByCamp) if (r.campaignId) qualifiedMap.set(r.campaignId, r._count._all);

    return rows.map((r) => {
      const sent = sentByCamp.get(r.id) ?? 0;
      const replies = replyByCamp.get(r.id) ?? 0;
      const qualified = qualifiedMap.get(r.id) ?? 0;
      const metrics: CampaignMetrics = {
        sent,
        replies,
        replyRate: sent > 0 ? Math.min(1, replies / sent) : 0,
        qualified,
      };
      return { ...r, metrics };
    });
  },

  async get(id: string) {
    const prisma = getPrisma();
    const c = await prisma.campaign.findUnique({ where: { id } });
    if (!c) throw Errors.notFound('campaign', id);
    return c;
  },

  async create(input: CreateInput, createdById: string | null) {
    const prisma = getPrisma();
    return prisma.campaign.create({
      data: {
        name: input.name,
        goalText: input.goalText,
        valueProp: input.valueProp,
        targetFilter: input.targetFilter as object,
        agentOverrides: input.agentOverrides as object,
        outreachAccountPool: input.outreachAccountPool ?? [],
        schedule: input.schedule as object,
        defaultMode: input.defaultMode,
        status: 'draft',
        createdById,
      },
    });
  },

  async update(id: string, patch: Partial<CreateInput>) {
    const prisma = getPrisma();
    return prisma.campaign.update({
      where: { id },
      data: {
        ...(patch.name && { name: patch.name }),
        ...(patch.goalText && { goalText: patch.goalText }),
        ...(patch.valueProp && { valueProp: patch.valueProp }),
        ...(patch.targetFilter && { targetFilter: patch.targetFilter as object }),
        ...(patch.agentOverrides && { agentOverrides: patch.agentOverrides as object }),
        ...(patch.outreachAccountPool && { outreachAccountPool: patch.outreachAccountPool }),
        ...(patch.schedule && { schedule: patch.schedule as object }),
        ...(patch.defaultMode && { defaultMode: patch.defaultMode }),
      },
    });
  },

  async setStatus(id: string, status: 'draft' | 'running' | 'paused' | 'finished') {
    const prisma = getPrisma();
    return prisma.campaign.update({ where: { id }, data: { status } });
  },

  /**
   * Add a fixed set of contacts to a campaign and create conversations
   * immediately so the operator sees the chats appear in /inbox right
   * away, with the opener generation kicked off in the background.
   *
   * Three-step flow:
   *   1. Tag contacts with `cmp:<campaignId>` (preserves the bridge to
   *      the autonomous dispatcher's tags filter).
   *   2. Pre-flight: detect the reasons we *can't* create Telegram
   *      conversations at all (no outreach accounts / no active accounts)
   *      and surface them in the response.
   *   3. If unblocked: round-robin contacts across the campaign's
   *      outreach pool, upsert conversations, idempotently enqueue
   *      `outreach_first_message` jobs. The worker generates the opener
   *      and posts suggestions to the conversation.
   *
   * Campaign status and schedule gate sending, not draft preparation:
   * operators expect pending suggestions to appear right after adding
   * contacts, even when the campaign is paused or outside work hours.
   */
  async addContacts(id: string, contactIds: string[]) {
    const prisma = getPrisma();
    const c = await prisma.campaign.findUnique({ where: { id } });
    if (!c) throw Errors.notFound('campaign', id);
    const tag = `cmp:${id}`;

    const contacts = await prisma.contact.findMany({
      where: { id: { in: contactIds } },
      select: { id: true, tags: true, reachability: true },
    });

    let added = 0;
    await prisma.$transaction(async (tx) => {
      for (const ct of contacts) {
        if (ct.tags.includes(tag)) continue;
        await tx.contact.update({
          where: { id: ct.id },
          data: { tags: [...ct.tags, tag] },
        });
        added += 1;
      }

      const filter = (c.targetFilter ?? {}) as { tags?: string[] } & Record<string, unknown>;
      const tags = Array.isArray(filter.tags) ? filter.tags : [];
      if (!tags.includes(tag)) {
        await tx.campaign.update({
          where: { id },
          data: { targetFilter: { ...filter, tags: [...tags, tag] } as object },
        });
      }
    });

    // Pre-flight diagnostics for immediate conversation creation.
    let blocker: 'no_accounts' | 'no_active_accounts' | null = null;
    if (!c.outreachAccountPool || c.outreachAccountPool.length === 0) blocker = 'no_accounts';

    let chatsCreated = 0;
    let suggestionsQueued = 0;
    if (!blocker) {
      const accounts = await prisma.tgAccount.findMany({
        where: { id: { in: c.outreachAccountPool }, status: 'active' },
        orderBy: { sentTodayMsg: 'asc' },
      });
      if (accounts.length === 0) {
        blocker = 'no_active_accounts';
      } else {
        // Only TG-reachable contacts get a chat now; manual/email/etc.
        // stay tagged for the operator's manual outreach flow.
        const reachable = await prisma.contact.findMany({
          where: { id: { in: contactIds }, reachability: 'reachable_tg' },
          include: {
            conversations: {
              where: { campaignId: id },
              select: { id: true },
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
          },
        });

        const queues = getQueues();
        let i = 0;
        for (const ct of reachable) {
          const existing = ct.conversations[0];
          let convId = existing?.id;
          if (!convId) {
            const acct = accounts[i % accounts.length]!;
            i += 1;
            const conv = await prisma.conversation.upsert({
              where: { tgAccountId_contactId: { tgAccountId: acct.id, contactId: ct.id } },
              update: { campaignId: id, mode: c.defaultMode },
              create: {
                tgAccountId: acct.id,
                contactId: ct.id,
                campaignId: id,
                status: 'active',
                mode: c.defaultMode,
              },
            });
            convId = conv.id;
            chatsCreated += 1;
          }

          const [messageCount, openingSuggestionCount] = await Promise.all([
            prisma.message.count({ where: { conversationId: convId } }),
            prisma.suggestion.count({
              where: {
                conversationId: convId,
                agentName: 'opening_composer',
                status: { in: ['pending', 'approved', 'sent'] },
              },
            }),
          ]);
          if (messageCount > 0 || openingSuggestionCount > 0) continue;

          await queues.agentRun.add(
            'outreach_first_message',
            {
              pipeline: 'outreach_first_message',
              conversationId: convId,
              campaignId: id,
              contactId: ct.id,
            },
            {
              attempts: 3,
              backoff: { type: 'exponential', delay: 5_000 },
              jobId: `outreach_first_message:${convId}`,
              removeOnComplete: true,
              removeOnFail: true,
            },
          );
          suggestionsQueued += 1;
        }
      }
    }

    return {
      added,
      requested: contactIds.length,
      chatsCreated,
      suggestionsQueued,
      blocker,
    };
  },

  /**
   * Pick `limit` candidate contacts that match the campaign's `targetFilter`.
   * Drafts are returned empty for now — the UI shows the candidate set and a
   * note that draft generation runs once the campaign is started; we don't
   * burn LLM tokens just because someone clicked "preview".
   */
  async preview(id: string, limit = 5) {
    const c = await this.get(id);
    const prisma = getPrisma();

    const filter = (c.targetFilter ?? {}) as TargetFilterShape;
    const contacts = await prisma.contact.findMany({
      where: {
        ...(filter.roleGuess?.length && { roleGuess: { in: filter.roleGuess as never[] } }),
        ...(filter.minConfidence != null && { confidence: { gte: filter.minConfidence } }),
        reachability: 'reachable_tg',
        status: { in: ['new', 'qualified'] },
        ...(filter.platforms?.length && {
          channel: { platform: { in: filter.platforms as never[] } },
        }),
      },
      include: { channel: true },
      take: limit * 3,
    });

    const items = contacts.slice(0, limit).map((ct) => ({
      contactId: ct.id,
      contactValue: ct.value,
      channelTitle: ct.channel?.title ?? ct.channel?.handle ?? undefined,
      drafts: [] as { text: string; riskScore?: number; rationale?: string }[],
    }));

    return { items };
  },
};
