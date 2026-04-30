import { getPrisma } from '@nosquare/db';
import type { z } from 'zod';
import type { ContactFiltersZ, ContactStatusZ } from '@nosquare/shared';
import { Errors } from '@nosquare/shared';

type Filters = z.infer<typeof ContactFiltersZ>;
type Status = z.infer<typeof ContactStatusZ>;

export const contactsService = {
  async list(filters: Filters & { limit?: number }) {
    const prisma = getPrisma();
    return prisma.contact.findMany({
      where: {
        ...(filters.channelId && { channelId: filters.channelId }),
        ...(filters.type && { type: filters.type }),
        ...(filters.roleGuess && { roleGuess: filters.roleGuess }),
        ...(filters.reachability && { reachability: filters.reachability }),
        ...(filters.status && { status: filters.status }),
        ...(filters.q && {
          OR: [
            { value: { contains: filters.q, mode: 'insensitive' } },
            { rawValue: { contains: filters.q, mode: 'insensitive' } },
          ],
        }),
      },
      include: {
        channel: { select: { id: true, handle: true, platform: true, title: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: filters.limit ?? 200,
    });
  },

  async update(id: string, patch: { status?: Status; tags?: string[] }) {
    const prisma = getPrisma();
    return prisma.contact.update({
      where: { id },
      data: {
        ...(patch.status && { status: patch.status }),
        ...(patch.tags && { tags: patch.tags }),
      },
    });
  },

  async draft(id: string) {
    const prisma = getPrisma();
    const c = await prisma.contact.findUnique({
      where: { id },
      include: { channel: true },
    });
    if (!c) throw Errors.notFound('contact', id);
    // Latest manual-outreach suggestion goes through the conversation it belongs to;
    // for contacts without a conversation we just return whatever the channel has.
    const conv = await prisma.conversation.findFirst({
      where: { contactId: id },
      orderBy: { createdAt: 'desc' },
    });
    let text = '';
    if (conv) {
      const sug = await prisma.suggestion.findFirst({
        where: { conversationId: conv.id, status: 'pending' },
        orderBy: { createdAt: 'desc' },
      });
      text = sug?.text ?? '';
    }
    return {
      text,
      channel: c.channel ? { title: c.channel.title, description: c.channel.description } : undefined,
      analysis: c.channel?.analysis ?? undefined,
    };
  },
};
