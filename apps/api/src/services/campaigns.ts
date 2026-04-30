import { getPrisma } from '@nosquare/db';
import { Errors } from '@nosquare/shared';
import type { z } from 'zod';
import type { CreateCampaignInputZ } from '@nosquare/shared';

type CreateInput = z.infer<typeof CreateCampaignInputZ>;

export const campaignsService = {
  async list() {
    const prisma = getPrisma();
    return prisma.campaign.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { conversations: true } },
      },
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
};
