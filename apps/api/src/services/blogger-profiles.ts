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
        // Surface the media kits / stat screenshots attached to this profile so
        // the detail view can offer a (presigned) download per asset. We expose
        // only safe metadata — never the s3Key or any credential.
        mediaAssets: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!profile) throw Errors.notFound('blogger_profile', id);
    return {
      ...profile,
      // Prisma serializes Decimal to a string over JSON; map confidence back to
      // a JS number at the API boundary so the frontend gets a real number.
      dataPoints: profile.dataPoints.map((dp) => ({
        ...dp,
        confidence: Number(dp.confidence),
      })),
      mediaAssets: profile.mediaAssets.map((a) => ({
        id: a.id,
        kind: a.kind,
        mime: a.mime,
        bytes: a.bytes,
        createdAt: a.createdAt,
      })),
    };
  },
};
