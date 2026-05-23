import { getPrisma } from '@nosquare/db';

const DAY_MS = 24 * 3600 * 1000;

export interface DashboardData {
  channels: {
    total: number;
    new: number;
    scraping: number;
    extracted: number;
    failed: number;
  };
  contacts: { total: number; reachableTg: number; manual: number };
  conversations: { active: number; assisted: number; manual: number; auto: number };
  campaigns: { running: number; paused: number };
  cost: { tokensToday: number; costTodayUsd: number; cost7dUsd: number };
  // Agency-sourcing-matching (agency_sourcing / blogger_matching). All zero
  // until those features are used.
  agency: {
    bloggersProfiled: number;
    profileDataPoints: number;
    profileDataPointsByField: Record<string, number>;
    matchRequests: number;
    agentCost7dUsd: number;
  };
  replyRate7d: number;
  recentActivity: Array<{
    id: string;
    type: 'channel_extracted' | 'message_sent' | 'reply' | 'escalation' | 'failed';
    title: string;
    subtitle?: string;
    at: string;
  }>;
}

export const dashboardService = {
  async stats(): Promise<DashboardData> {
    const prisma = getPrisma();
    const dayAgo = new Date(Date.now() - DAY_MS);
    const sevenDaysAgo = new Date(Date.now() - 7 * DAY_MS);

    const [
      channelsByStatus,
      contactsTotal,
      contactsReachable,
      contactsManual,
      convByStatusMode,
      campaignsRunning,
      campaignsPaused,
      tokensToday,
      cost7d,
      messagesSent7d,
      messagesReplied7d,
      recentChannels,
      recentMessages,
      bloggersProfiled,
      dataPointsByField,
      matchRequests,
      agencyAgentCost7d,
    ] = await Promise.all([
      prisma.channel.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.contact.count(),
      prisma.contact.count({ where: { reachability: 'reachable_tg' } }),
      prisma.contact.count({ where: { reachability: 'manual' } }),
      prisma.conversation.groupBy({
        by: ['status', 'mode'],
        _count: { _all: true },
      }),
      prisma.campaign.count({ where: { status: 'running' } }),
      prisma.campaign.count({ where: { status: 'paused' } }),
      prisma.agentRun.aggregate({
        _sum: { tokensIn: true, tokensOut: true, costUsd: true },
        where: { createdAt: { gte: dayAgo } },
      }),
      prisma.agentRun.aggregate({
        _sum: { costUsd: true },
        where: { createdAt: { gte: sevenDaysAgo } },
      }),
      prisma.message.count({
        where: { direction: 'out_', status: 'sent', createdAt: { gte: sevenDaysAgo } },
      }),
      prisma.message.count({
        where: { direction: 'in_', createdAt: { gte: sevenDaysAgo } },
      }),
      prisma.channel.findMany({
        where: { status: 'extracted' },
        orderBy: { scrapedAt: 'desc' },
        take: 5,
        select: {
          id: true,
          handle: true,
          title: true,
          scrapedAt: true,
          _count: { select: { contacts: true } },
        },
      }),
      prisma.message.findMany({
        where: { OR: [{ direction: 'in_' }, { status: 'sent' }] },
        orderBy: { createdAt: 'desc' },
        take: 8,
        include: {
          conversation: {
            include: {
              contact: { select: { value: true } },
            },
          },
        },
      }),
      // Agency-sourcing-matching metrics (return 0 when the feature is unused).
      prisma.bloggerProfile.count(),
      prisma.profileDataPoint.groupBy({ by: ['field'], _count: { _all: true } }),
      prisma.adBrief.count(),
      prisma.agentRun.aggregate({
        _sum: { costUsd: true },
        where: {
          createdAt: { gte: sevenDaysAgo },
          agentName: {
            in: [
              'campaign_type_builder',
              'rate_card_extractor',
              'audience_stats_extractor',
              'blogger_matcher',
            ],
          },
        },
      }),
    ]);

    const channelByStatus = (status: string): number =>
      channelsByStatus.find((r) => r.status === status)?._count._all ?? 0;
    const channelsTotal = channelsByStatus.reduce((s, r) => s + r._count._all, 0);

    let convActive = 0;
    let convAssisted = 0;
    let convManual = 0;
    let convAuto = 0;
    for (const r of convByStatusMode) {
      const c = r._count._all;
      if (r.status === 'active') convActive += c;
      if (r.mode === 'assisted') convAssisted += c;
      if (r.mode === 'manual') convManual += c;
      if (r.mode === 'auto') convAuto += c;
    }

    const tokensIn = tokensToday._sum.tokensIn ?? 0;
    const tokensOut = tokensToday._sum.tokensOut ?? 0;
    const tokensTodayTotal = tokensIn + tokensOut;
    const costToday = Number(tokensToday._sum.costUsd ?? 0);
    const cost7dUsd = Number(cost7d._sum.costUsd ?? 0);
    const replyRate =
      messagesSent7d > 0 ? Math.min(1, messagesReplied7d / messagesSent7d) : 0;

    const recent: DashboardData['recentActivity'] = [];
    for (const ch of recentChannels) {
      recent.push({
        id: `channel:${ch.id}`,
        type: 'channel_extracted',
        title: `${ch.title ?? ch.handle} — извлечено ${ch._count.contacts} контактов`,
        subtitle: ch.handle,
        at: (ch.scrapedAt ?? new Date()).toISOString(),
      });
    }
    for (const m of recentMessages) {
      const isReply = m.direction === 'in_';
      const partner = m.conversation.contact.value;
      recent.push({
        id: `message:${m.id}`,
        type: isReply ? 'reply' : 'message_sent',
        title: isReply ? `Ответ от ${partner}` : `Отправлено: ${partner}`,
        subtitle: m.text.slice(0, 80),
        at: m.createdAt.toISOString(),
      });
    }
    recent.sort((a, b) => b.at.localeCompare(a.at));

    return {
      channels: {
        total: channelsTotal,
        new: channelByStatus('new'),
        scraping: channelByStatus('scraping') + channelByStatus('extracting'),
        extracted: channelByStatus('extracted') + channelByStatus('ready'),
        failed: channelByStatus('failed'),
      },
      contacts: {
        total: contactsTotal,
        reachableTg: contactsReachable,
        manual: contactsManual,
      },
      conversations: {
        active: convActive,
        assisted: convAssisted,
        manual: convManual,
        auto: convAuto,
      },
      campaigns: { running: campaignsRunning, paused: campaignsPaused },
      cost: {
        tokensToday: tokensTodayTotal,
        costTodayUsd: costToday,
        cost7dUsd: cost7dUsd,
      },
      agency: {
        bloggersProfiled,
        profileDataPoints: dataPointsByField.reduce((s, r) => s + r._count._all, 0),
        profileDataPointsByField: Object.fromEntries(
          dataPointsByField.map((r) => [r.field, r._count._all]),
        ),
        matchRequests,
        agentCost7dUsd: Number(agencyAgentCost7d._sum.costUsd ?? 0),
      },
      replyRate7d: replyRate,
      recentActivity: recent.slice(0, 10),
    };
  },
};
