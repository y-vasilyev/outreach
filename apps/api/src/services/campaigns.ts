import { getPrisma } from '@nosquare/db';
import { Errors } from '@nosquare/shared';
import type { z } from 'zod';
import type { CreateCampaignInputZ } from '@nosquare/shared';

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
