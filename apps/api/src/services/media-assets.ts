import { getPrisma } from '@nosquare/db';
import { Errors, type MediaAssetKind } from '@nosquare/shared';
import { getObjectStore, mediaAssetKey } from '@nosquare/storage';

const DEFAULT_TTL_SECONDS = 300;

/**
 * Presigned media-asset access service (agency-sourcing-matching M6, task 6.4).
 * The UI never gets bucket credentials — only short-lived presigned URLs
 * issued here. Gated behind ENABLE_OBJECT_STORAGE at the route layer; this
 * service additionally throws a clear error when storage is unavailable so a
 * misconfigured env never silently returns a broken URL.
 */
export const mediaAssetsService = {
  /** Short-lived presigned GET URL for an existing asset. */
  async downloadUrl(
    id: string,
    ttlSeconds = DEFAULT_TTL_SECONDS,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    const prisma = getPrisma();
    const asset = await prisma.mediaAsset.findUnique({ where: { id } });
    if (!asset) throw Errors.notFound('media_asset', id);
    if (!asset.s3Key) {
      // Honest-pending row: the bytes were never downloaded/uploaded, so the
      // s3Key sentinel is empty. Returning a presigned URL here would be a dead
      // link (no object exists). 409 = the asset exists but has no object yet.
      throw Errors.conflict('media asset has no stored object (pending download)');
    }
    const store = getObjectStore();
    if (!store) throw Errors.badRequest('object storage is not available');
    const url = await store.getPresignedGetUrl(asset.s3Key, ttlSeconds);
    return { url, expiresInSeconds: ttlSeconds };
  },

  /**
   * Presigned PUT URL for a NEW asset. Creates the `media_asset` row first so
   * the key is namespaced by the generated assetId, then returns the upload
   * URL. The client PUTs the bytes directly to storage.
   */
  async uploadUrl(
    input: {
      conversationId?: string | null;
      profileId?: string | null;
      kind: MediaAssetKind;
      mime?: string | null;
    },
    ttlSeconds = DEFAULT_TTL_SECONDS,
  ): Promise<{ assetId: string; key: string; url: string; expiresInSeconds: number }> {
    const store = getObjectStore();
    if (!store) throw Errors.badRequest('object storage is not available');
    const prisma = getPrisma();

    const asset = await prisma.mediaAsset.create({
      data: {
        conversationId: input.conversationId ?? null,
        profileId: input.profileId ?? null,
        kind: input.kind,
        s3Key: '',
        mime: input.mime ?? null,
      },
    });

    const key = mediaAssetKey({
      profileId: input.profileId ?? null,
      conversationId: input.conversationId ?? null,
      assetId: asset.id,
    });
    await prisma.mediaAsset.update({ where: { id: asset.id }, data: { s3Key: key } });

    const url = await store.getPresignedPutUrl(key, input.mime ?? undefined, ttlSeconds);
    return { assetId: asset.id, key, url, expiresInSeconds: ttlSeconds };
  },
};
