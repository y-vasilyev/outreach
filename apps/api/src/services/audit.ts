import { getPrisma } from '@nosquare/db';

export const auditService = {
  async log(input: {
    userId: string | null;
    action: string;
    targetType: string;
    targetId?: string | null;
    payload?: Record<string, unknown>;
  }) {
    const prisma = getPrisma();
    return prisma.auditLog.create({
      data: {
        userId: input.userId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        payload: (input.payload ?? {}) as object,
      },
    });
  },

  async list(limit = 100) {
    const prisma = getPrisma();
    return prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { user: { select: { email: true } } },
    });
  },
};
