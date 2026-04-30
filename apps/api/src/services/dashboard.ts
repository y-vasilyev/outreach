import { getPrisma } from '@nosquare/db';

export const dashboardService = {
  async stats() {
    const prisma = getPrisma();
    const [
      channelsTotal,
      channelsExtracted,
      contactsReachable,
      conversationsActive,
      campaignsRunning,
      tgAccountsActive,
      messagesLast24h,
      tokensLast24h,
    ] = await Promise.all([
      prisma.channel.count(),
      prisma.channel.count({ where: { status: 'extracted' } }),
      prisma.contact.count({ where: { reachability: 'reachable_tg', status: 'qualified' } }),
      prisma.conversation.count({ where: { status: 'active' } }),
      prisma.campaign.count({ where: { status: 'running' } }),
      prisma.tgAccount.count({ where: { status: 'active' } }),
      prisma.message.count({
        where: { createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } },
      }),
      prisma.agentRun.aggregate({
        _sum: { tokensIn: true, tokensOut: true, costUsd: true },
        where: { createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } },
      }),
    ]);

    return {
      channelsTotal,
      channelsExtracted,
      contactsReachable,
      conversationsActive,
      campaignsRunning,
      tgAccountsActive,
      messagesLast24h,
      tokensLast24h: {
        in: tokensLast24h._sum.tokensIn ?? 0,
        out: tokensLast24h._sum.tokensOut ?? 0,
        costUsd: Number(tokensLast24h._sum.costUsd ?? 0),
      },
    };
  },

  async byPlatform() {
    const prisma = getPrisma();
    const rows = await prisma.channel.groupBy({
      by: ['platform', 'status'],
      _count: { _all: true },
    });
    return rows.map((r) => ({
      platform: r.platform,
      status: r.status,
      count: r._count._all,
    }));
  },
};
