import { getPrisma } from '@nosquare/db';
import { Errors } from '@nosquare/shared';

/**
 * Blogger commercial profile read service (agency-sourcing-matching M5, task
 * 5.4). Read-only: profiles are written by the profile-extract worker. The
 * detail view returns the standardized rolled-up fields plus the contributing
 * `profile_data_point` rows (with provenance) so an operator can audit how the
 * profile was composed.
 */
export const bloggerProfilesService = {
  async list(opts: { limit?: number; offset?: number } = {}) {
    const prisma = getPrisma();
    const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const skip = Math.max(opts.offset ?? 0, 0);
    const [items, total] = await Promise.all([
      prisma.bloggerProfile.findMany({
        orderBy: { updatedAt: 'desc' },
        take,
        skip,
        include: { _count: { select: { dataPoints: true } } },
      }),
      prisma.bloggerProfile.count(),
    ]);
    return { items, total, limit: take, offset: skip };
  },

  async get(id: string) {
    const prisma = getPrisma();
    const profile = await prisma.bloggerProfile.findUnique({
      where: { id },
      include: {
        dataPoints: { orderBy: [{ field: 'asc' }, { capturedAt: 'desc' }] },
      },
    });
    if (!profile) throw Errors.notFound('blogger_profile', id);
    return profile;
  },
};
