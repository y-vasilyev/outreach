import { getPrisma } from '@nosquare/db';
import { buildAjtbdScaffold, Errors } from '@nosquare/shared';
import type { z } from 'zod';
import type { CreateCampaignInputZ } from '@nosquare/shared';

import { getQueues } from '../queues.js';
import { campaignTypesService } from './campaign-types.js';
import { getFeatureFlags } from '../feature-flags.js';

const DEFAULT_CAMPAIGN_TYPE_KEY = 'custdev';

/**
 * Resolve the campaign type (by id, else the default `custdev`) and validate
 * the supplied goal against its schema. Returns `{ typeId, goal }` to persist.
 * For custdev the goal falls back to the AJTBD (provided or scaffolded), so
 * existing create flows that only send `ajtbd` keep working.
 */
async function resolveTypeAndGoal(opts: {
  typeId?: string;
  goal?: Record<string, unknown>;
  ajtbd?: Record<string, unknown>;
  goalText: string;
  valueProp: string;
}): Promise<{ typeId: string; goal: object }> {
  const prisma = getPrisma();
  const type = opts.typeId
    ? await prisma.campaignType.findUnique({ where: { id: opts.typeId } })
    : await prisma.campaignType.findUnique({ where: { key: DEFAULT_CAMPAIGN_TYPE_KEY } });
  if (!type) {
    throw opts.typeId
      ? Errors.notFound('campaign_type', opts.typeId)
      : Errors.internal('default campaign_type "custdev" missing; run migration/seed');
  }
  // While the registry is dark, only the default custdev type is selectable
  // — a client cannot opt a campaign into agency_sourcing (or any custom
  // type) until ENABLE_CAMPAIGN_TYPES is on.
  if (!getFeatureFlags().get('campaign_types') && type.key !== DEFAULT_CAMPAIGN_TYPE_KEY) {
    throw Errors.badRequest('campaign types are not enabled', { typeKey: type.key });
  }
  const candidateGoal =
    opts.goal ??
    (type.key === DEFAULT_CAMPAIGN_TYPE_KEY
      ? opts.ajtbd ?? buildAjtbdScaffold({ goalText: opts.goalText, valueProp: opts.valueProp })
      : undefined);
  const goal = campaignTypesService.validateGoal(type, candidateGoal);
  return { typeId: type.id, goal };
}

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
    const ajtbd =
      input.ajtbd ?? buildAjtbdScaffold({ goalText: input.goalText, valueProp: input.valueProp });
    const { typeId, goal } = await resolveTypeAndGoal({
      ...(input.typeId !== undefined && { typeId: input.typeId }),
      ...(input.goal !== undefined && { goal: input.goal }),
      ajtbd: ajtbd as Record<string, unknown>,
      goalText: input.goalText,
      valueProp: input.valueProp,
    });
    return prisma.campaign.create({
      data: {
        name: input.name,
        goalText: input.goalText,
        valueProp: input.valueProp,
        ajtbd: ajtbd as object,
        typeId,
        goal,
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

    // Re-resolve + validate the type/goal only when the client touches the
    // type, the goal, or the AJTBD (custdev goal mirrors the AJTBD).
    let typeGoal: { typeId: string; goal: object } | undefined;
    if (patch.typeId !== undefined || patch.goal !== undefined || patch.ajtbd !== undefined) {
      const existing = await prisma.campaign.findUnique({ where: { id } });
      if (!existing) throw Errors.notFound('campaign', id);
      const ajtbd = (patch.ajtbd ?? existing.ajtbd ?? undefined) as
        | Record<string, unknown>
        | undefined;
      typeGoal = await resolveTypeAndGoal({
        ...(patch.typeId !== undefined
          ? { typeId: patch.typeId }
          : existing.typeId
            ? { typeId: existing.typeId }
            : {}),
        ...(patch.goal !== undefined && { goal: patch.goal }),
        ...(ajtbd !== undefined && { ajtbd }),
        goalText: patch.goalText ?? existing.goalText,
        valueProp: patch.valueProp ?? existing.valueProp,
      });
    }

    return prisma.campaign.update({
      where: { id },
      data: {
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.goalText !== undefined && { goalText: patch.goalText }),
        ...(patch.valueProp !== undefined && { valueProp: patch.valueProp }),
        ...(patch.ajtbd !== undefined && { ajtbd: patch.ajtbd as object }),
        ...(typeGoal !== undefined && { typeId: typeGoal.typeId, goal: typeGoal.goal }),
        ...(patch.targetFilter !== undefined && { targetFilter: patch.targetFilter as object }),
        ...(patch.agentOverrides !== undefined && { agentOverrides: patch.agentOverrides as object }),
        ...(patch.outreachAccountPool !== undefined && { outreachAccountPool: patch.outreachAccountPool }),
        ...(patch.schedule !== undefined && { schedule: patch.schedule as object }),
        ...(patch.defaultMode !== undefined && { defaultMode: patch.defaultMode }),
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
    const channelWhere =
      (filter.platforms?.length || filter.languages?.length || filter.topics?.length)
        ? {
            ...(filter.platforms?.length && { platform: { in: filter.platforms as never[] } }),
            ...(filter.languages?.length && { language: { in: filter.languages } }),
            ...(filter.topics?.length && {
              OR: filter.topics.flatMap((topic) => [
                { title: { contains: topic, mode: 'insensitive' as const } },
                { description: { contains: topic, mode: 'insensitive' as const } },
                {
                  analysis: {
                    path: ['topic'],
                    string_contains: topic,
                    mode: 'insensitive' as const,
                  },
                },
              ]),
            }),
          }
        : undefined;
    const contacts = await prisma.contact.findMany({
      where: {
        ...(filter.roleGuess?.length && { roleGuess: { in: filter.roleGuess as never[] } }),
        ...(filter.minConfidence != null && { confidence: { gte: filter.minConfidence } }),
        reachability: 'reachable_tg',
        status: { in: ['new', 'qualified'] },
        ...(channelWhere && { channel: channelWhere }),
        ...(filter.tags?.length && { tags: { hasSome: filter.tags } }),
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
