import { BloggerPostMetricsZ, hasNumericPostMetric } from '@nosquare/shared';
import { getPrisma } from '@nosquare/db';
import type { ChannelSnapshot, ChannelSnapshotPost } from '@nosquare/platforms';

function cleanSnippet(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function postUrl(snapshot: ChannelSnapshot, post: ChannelSnapshotPost): string | null {
  const firstUrl = post.urls.find((u) => /^https?:\/\//i.test(u));
  if (firstUrl) return firstUrl;
  if (snapshot.platform === 'telegram') return `https://t.me/${snapshot.handle}/${post.id}`;
  if (snapshot.platform === 'youtube' && post.id) return `https://www.youtube.com/watch?v=${post.id}`;
  return null;
}

function dateOrNull(value: string): Date | null {
  const d = new Date(value);
  return Number.isNaN(d.valueOf()) ? null : d;
}

export async function upsertPostInsightsFromSnapshot(opts: {
  channelId: string;
  snapshot: ChannelSnapshot;
}): Promise<{ profileId: string | null; upserted: number; skipped: string | null }> {
  const prisma = getPrisma();
  const profile = await prisma.bloggerProfile.findUnique({
    where: { channelId: opts.channelId },
    select: { id: true },
  });
  if (!profile) return { profileId: null, upserted: 0, skipped: 'no_profile' };

  const now = new Date();
  let upserted = 0;
  for (const post of opts.snapshot.posts) {
    if (!post.id) continue;
    const metrics = BloggerPostMetricsZ.parse(post.metrics ?? {});
    const hasMetrics = hasNumericPostMetric(metrics);
    // Post-example image (blogger-profile-who-is-this). YouTube exposes a
    // deterministic PUBLIC thumbnail by video id (served directly, no storage).
    // Telegram public post photos are fetched lazily by the image endpoint via
    // the parser client → leave `pending`. Others have no public preview →
    // `unsupported`.
    const youtubeThumb =
      opts.snapshot.platform === 'youtube' && post.id
        ? `https://i.ytimg.com/vi/${encodeURIComponent(post.id)}/hqdefault.jpg`
        : null;
    const imageFields =
      opts.snapshot.platform === 'youtube'
        ? { imageS3Key: youtubeThumb, imageStatus: youtubeThumb ? 'ok' : 'unsupported' }
        : opts.snapshot.platform === 'telegram'
          ? { imageStatus: 'pending' }
          : { imageStatus: 'unsupported' };
    await prisma.bloggerPostInsight.upsert({
      where: {
        profileId_platform_externalPostId: {
          profileId: profile.id,
          platform: opts.snapshot.platform,
          externalPostId: post.id,
        },
      },
      create: {
        profileId: profile.id,
        channelId: opts.channelId,
        platform: opts.snapshot.platform,
        externalPostId: post.id,
        url: postUrl(opts.snapshot, post),
        publishedAt: dateOrNull(post.date),
        textSnippet: cleanSnippet(post.text),
        mediaKind: post.mediaKind ?? 'post',
        metrics: metrics as never,
        metricCapturedAt: hasMetrics ? now : null,
        source:
          opts.snapshot.platform === 'telegram'
            ? 'telegram_public_parse'
            : 'scrapecreators',
        sourceRawRef: `${opts.snapshot.platform}:${opts.snapshot.externalId}:${post.id}`,
        ...imageFields,
      },
      update: {
        channelId: opts.channelId,
        url: postUrl(opts.snapshot, post),
        publishedAt: dateOrNull(post.date),
        textSnippet: cleanSnippet(post.text),
        mediaKind: post.mediaKind ?? 'post',
        metrics: metrics as never,
        metricCapturedAt: hasMetrics ? now : null,
        source:
          opts.snapshot.platform === 'telegram'
            ? 'telegram_public_parse'
            : 'scrapecreators',
        sourceRawRef: `${opts.snapshot.platform}:${opts.snapshot.externalId}:${post.id}`,
      },
    });
    upserted += 1;
  }

  await prisma.bloggerProfile.update({
    where: { id: profile.id },
    data: {
      postInsightRefreshStatus: 'idle',
      postInsightRefreshError: null,
      postInsightRefreshedAt: now,
    },
  });

  return { profileId: profile.id, upserted, skipped: null };
}

export async function markPostInsightRefreshFailedForChannel(
  channelId: string,
  error: string,
): Promise<void> {
  const prisma = getPrisma();
  await prisma.bloggerProfile
    .update({
      where: { channelId },
      data: {
        postInsightRefreshStatus: 'failed',
        postInsightRefreshError: error.slice(0, 500),
      },
    })
    .catch(() => undefined);
}
