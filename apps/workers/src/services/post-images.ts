import { getObjectStore } from '@nosquare/storage';
import { getPrisma } from '@nosquare/db';
import { getFeatureFlags } from '../feature-flags.js';
import { logger } from '../logger.js';

/** Minimal tg-client surface this service needs (the public-post downloader). */
export interface PublicPostMediaDownloader {
  downloadPublicPostMedia(opts: { handle: string; postId: string }): Promise<Uint8Array | null>;
}

/** Cap how many post images we fetch per refresh (cost / hot-path bound). */
const MAX_POST_IMAGES = 6;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Store Telegram post-example preview images to S3 (blogger-profile-who-is-this).
 * Telegram public post photos are not in the normalized snapshot, so we fetch
 * them by handle+postId via the parser client and `putObject` under a safe key.
 * Best-effort + behind `object_storage`; never throws into the caller.
 * `imageStatus`: `ok` (stored) | `unsupported` (no public photo) | `failed`.
 */
export async function storeTelegramPostImages(opts: {
  profileId: string;
  handle: string;
  posts: Array<{ id: string }>;
  tg: PublicPostMediaDownloader;
}): Promise<{ stored: number }> {
  if (!getFeatureFlags().get('object_storage')) return { stored: 0 };
  const store = getObjectStore();
  if (!store) return { stored: 0 };
  const prisma = getPrisma();
  let stored = 0;

  for (const post of opts.posts.slice(0, MAX_POST_IMAGES)) {
    if (!post.id) continue;
    const where = {
      profileId_platform_externalPostId: {
        profileId: opts.profileId,
        platform: 'telegram',
        externalPostId: post.id,
      },
    };
    const existing = await prisma.bloggerPostInsight
      .findUnique({ where, select: { imageStatus: true } })
      .catch(() => null);
    if (!existing) continue; // upsert didn't create this row (shouldn't happen)
    if (existing.imageStatus === 'ok') continue; // cached

    try {
      const bytes = await opts.tg.downloadPublicPostMedia({ handle: opts.handle, postId: post.id });
      if (!bytes || bytes.byteLength === 0) {
        await prisma.bloggerPostInsight.update({ where, data: { imageStatus: 'unsupported' } });
        continue;
      }
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        await prisma.bloggerPostInsight.update({ where, data: { imageStatus: 'unsupported' } });
        continue;
      }
      const key = `bloggers/${opts.profileId}/posts/telegram/${encodeURIComponent(post.id)}`;
      await store.putObject(key, bytes, 'image/jpeg');
      await prisma.bloggerPostInsight.update({
        where,
        data: { imageS3Key: key, imageStatus: 'ok' },
      });
      stored += 1;
    } catch (err) {
      logger.warn(
        { event: 'post_image.failed', profileId: opts.profileId, postId: post.id, err: (err as Error).message },
        'telegram post image store failed',
      );
      await prisma.bloggerPostInsight
        .update({ where, data: { imageStatus: 'failed' } })
        .catch(() => undefined);
    }
  }
  return { stored };
}
