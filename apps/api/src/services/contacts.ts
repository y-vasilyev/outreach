import { getPrisma } from '@nosquare/db';
import type { z } from 'zod';
import type { ContactFiltersZ } from '@nosquare/shared';

type Filters = z.infer<typeof ContactFiltersZ>;

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
};
