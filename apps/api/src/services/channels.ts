import { getPrisma } from '@nosquare/db';
import { Errors, type Platform } from '@nosquare/shared';
import { getQueues } from '../queues.js';

function normalizeHandle(platform: Platform, raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  if (platform === 'telegram') {
    const m =
      t.match(/^@?([a-zA-Z][\w]{4,31})$/) ||
      t.match(/^(?:https?:\/\/)?t\.me\/([a-zA-Z][\w]{4,31})/i);
    return m?.[1] ? m[1].toLowerCase() : t.replace(/^@/, '').toLowerCase();
  }
  if (platform === 'instagram') {
    const m =
      t.match(/^@?([a-zA-Z0-9._]{1,30})$/) ||
      t.match(/^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([a-zA-Z0-9._]+)/i);
    return m?.[1] ? m[1].toLowerCase() : t.replace(/^@/, '').toLowerCase();
  }
  if (platform === 'youtube') {
    const m =
      t.match(/^(@[a-zA-Z0-9._-]{3,})/) ||
      t.match(/^(?:https?:\/\/)?(?:www\.)?youtube\.com\/(@[a-zA-Z0-9._-]+|channel\/UC[\w-]+)/i);
    return m?.[1] ?? t;
  }
  return t;
}

export const channelsService = {
  async list(filters: { platform?: Platform; status?: string; q?: string; limit?: number }) {
    const prisma = getPrisma();
    return prisma.channel.findMany({
      where: {
        ...(filters.platform && { platform: filters.platform }),
        ...(filters.status && { status: filters.status as never }),
        ...(filters.q && {
          OR: [
            { handle: { contains: filters.q, mode: 'insensitive' } },
            { title: { contains: filters.q, mode: 'insensitive' } },
          ],
        }),
      },
      orderBy: { createdAt: 'desc' },
      take: filters.limit ?? 100,
      include: { _count: { select: { contacts: true } } },
    });
  },

  async get(id: string) {
    const prisma = getPrisma();
    const ch = await prisma.channel.findUnique({
      where: { id },
      include: { contacts: true },
    });
    if (!ch) throw Errors.notFound('channel', id);
    return ch;
  },

  async import(opts: {
    platform: Platform;
    handles: string[];
    source: string;
    addedById?: string;
  }) {
    const prisma = getPrisma();
    const queues = getQueues();
    const created: { id: string; handle: string }[] = [];
    for (const raw of opts.handles) {
      const handle = normalizeHandle(opts.platform, raw);
      if (!handle) continue;
      const ch = await prisma.channel.upsert({
        where: { platform_handle: { platform: opts.platform, handle } },
        update: {},
        create: {
          platform: opts.platform,
          handle,
          status: 'new',
          source: opts.source,
          addedById: opts.addedById,
          links: [],
        },
      });
      created.push({ id: ch.id, handle: ch.handle });
      await queues.channelScrape.add('scrape', { channelId: ch.id });
    }
    return created;
  },

  async rescrape(id: string) {
    const prisma = getPrisma();
    const ch = await prisma.channel.findUnique({ where: { id } });
    if (!ch) throw Errors.notFound('channel', id);
    await prisma.channel.update({ where: { id }, data: { status: 'new', lastError: null } });
    const queues = getQueues();
    await queues.channelScrape.add('scrape', { channelId: id });
    return { ok: true };
  },
};
