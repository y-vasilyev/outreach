import { Queue } from 'bullmq';
import { BloggerPostMetricsZ, hasNumericPostMetric, QueueNames } from '@nosquare/shared';
import { getPrisma } from '@nosquare/db';
import type { ChannelSnapshot, ChannelSnapshotPost } from '@nosquare/platforms';
import { getRedis } from '../redis.js';
import { logger } from '../logger.js';

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
    // On UPDATE of an existing insight, apply the image fields only for the
    // DETERMINISTIC platforms (codex) — so an existing row gains the YouTube
    // thumbnail / unsupported marker on refresh. Telegram is omitted so we never
    // reset a (future) stored photo back to pending.
    const imageFieldsForUpdate = opts.snapshot.platform === 'telegram' ? {} : imageFields;
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
        ...imageFieldsForUpdate,
      },
    });
    upserted += 1;
  }

  // Prune stale Telegram album leftovers (very-strange-post-list bug). Albums
  // used to be stored as one insight per photo; now `collapseAlbums` folds an
  // album into a single post keyed by its anchor id, so the other members'
  // rows would linger and duplicate the post in the catalog forever. Delete any
  // `telegram_public_parse` insight that sits INSIDE the freshly-fetched window
  // (id ≥ the smallest id we just re-emitted) but is no longer in the snapshot.
  // Older history below the window is untouched — it just wasn't re-fetched.
  if (opts.snapshot.platform === 'telegram') {
    const keptIds = new Set(opts.snapshot.posts.map((p) => p.id).filter(Boolean));
    const keptNums = [...keptIds].map(Number).filter((n) => Number.isFinite(n));
    if (keptNums.length > 0) {
      const windowMin = Math.min(...keptNums);
      const existing = await prisma.bloggerPostInsight.findMany({
        where: { profileId: profile.id, platform: 'telegram', source: 'telegram_public_parse' },
        select: { id: true, externalPostId: true },
      });
      const staleIds = existing
        .filter((row) => {
          if (keptIds.has(row.externalPostId)) return false; // re-emitted this run
          const n = Number(row.externalPostId);
          return Number.isFinite(n) && n >= windowMin; // inside the fetch window
        })
        .map((row) => row.id);
      if (staleIds.length > 0) {
        await prisma.bloggerPostInsight.deleteMany({ where: { id: { in: staleIds } } });
      }
    }
  }

  await prisma.bloggerProfile.update({
    where: { id: profile.id },
    data: {
      postInsightRefreshStatus: 'idle',
      postInsightRefreshError: null,
      postInsightRefreshedAt: now,
    },
  });

  // Fresh post metrics change the CPM views basis (price-normalization-v2):
  // recompute the profile's active offer rows. Fire-and-forget — a failed
  // enqueue never fails the refresh itself.
  try {
    const renormalizeQueue = new Queue(QueueNames.offerRenormalize, { connection: getRedis() });
    await renormalizeQueue.add('renormalize', { profileId: profile.id });
  } catch (err) {
    logger.warn(
      { profileId: profile.id, err: (err as Error).message },
      'offer-renormalize enqueue failed after post-insight refresh',
    );
  }

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
