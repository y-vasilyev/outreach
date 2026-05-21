import { createHash } from 'node:crypto';
import { getFeatureFlags } from '../feature-flags.js';
import { redact, type MediaAssetKind } from '@nosquare/shared';
import {
  getObjectStore,
  mediaAssetKey,
  rawPayloadKey,
  buildRawPayloadSnapshot,
} from '@nosquare/storage';
import { getPrisma } from '@nosquare/db';
import { logger } from '../logger.js';

interface InboundMediaMeta {
  className: string;
  kind: 'image' | 'video' | 'document' | 'other';
  mime?: string;
  bytes?: number;
  fileName?: string;
}

/**
 * Map the lightweight inbound media `kind` to a `MediaAssetKind`. Documents
 * with a PDF mime are most likely media kits; otherwise keep the coarse kind.
 */
function resolveAssetKind(meta: InboundMediaMeta): MediaAssetKind {
  if (meta.kind === 'image') return 'screenshot';
  if (meta.kind === 'video') return 'video';
  if (meta.kind === 'document') {
    if (meta.mime === 'application/pdf') return 'media_kit';
    return 'document';
  }
  return 'other';
}

/**
 * Persist inbound media to S3 + a `media_asset` row (agency-sourcing-matching
 * M6, task 6.2). DEGRADES SAFELY: any failure here is logged and swallowed —
 * inbound processing must never fail or drop the conversation because of media
 * persistence (spec: "degrade safely").
 *
 * Byte handling (B3): callers pass either the already-downloaded `bytes` OR a
 * `downloadBytes` thunk (the tg-client `downloadInboundMedia` path). When bytes
 * are obtained we upload to object storage and set `s3Key` + `bytes` + `sha256`.
 * When NO bytes are available (download unavailable / failed / returned null),
 * we record an HONEST metadata-only row with an EMPTY `s3Key` ('') — never a
 * key that points at an object that does not exist (which would yield a dead
 * presigned URL). The `s3Key` column is NOT NULL (no migration here), so '' is
 * the sentinel for "no stored object"; the API download endpoint treats a
 * falsy s3Key (covers '') as 4xx rather than issuing a presigned URL.
 */
export async function persistInboundMedia(opts: {
  conversationId: string;
  channelId?: string | null;
  sourceTgMsgId?: string | null;
  media: InboundMediaMeta;
  /** Already-downloaded bytes, when the caller has them. */
  bytes?: Uint8Array;
  /**
   * Lazy byte fetch (tg-client `downloadInboundMedia`). Invoked only when the
   * storage flag is on and `bytes` weren't supplied. Must resolve to null
   * (never throw) when bytes can't be obtained — honest-pending then applies.
   */
  downloadBytes?: () => Promise<Uint8Array | null>;
}): Promise<{ persisted: boolean; assetId?: string; degraded?: string }> {
  if (!getFeatureFlags().get('object_storage')) {
    logger.warn(
      { conversationId: opts.conversationId, mediaClass: opts.media.className },
      'inbound media skipped: object storage disabled (ENABLE_OBJECT_STORAGE off)',
    );
    return { persisted: false, degraded: 'flag_off' };
  }

  const prisma = getPrisma();

  // Resolve the blogger profile (if any) so the key is namespaced per profile.
  let profileId: string | null = null;
  if (opts.channelId) {
    const profile = await prisma.bloggerProfile
      .findUnique({ where: { channelId: opts.channelId }, select: { id: true } })
      .catch(() => null);
    profileId = profile?.id ?? null;
  }

  try {
    const assetKind = resolveAssetKind(opts.media);
    // Create the row first so we have a stable assetId to derive the key from
    // (and so the asset is recorded even if the byte upload below degrades).
    // s3Key starts '' (the NOT-NULL "no object" sentinel) and is set to the
    // real key ONLY after a successful upload — an empty s3Key is an honest
    // "pending"/metadata-only record, never a dead URL.
    const created = await prisma.mediaAsset.create({
      data: {
        conversationId: opts.conversationId,
        profileId,
        kind: assetKind,
        s3Key: '',
        mime: opts.media.mime ?? null,
        bytes: opts.media.bytes ?? null,
        sha256: null,
        sourceTgMsgId: opts.sourceTgMsgId ?? null,
      },
    });

    const key = mediaAssetKey({
      profileId,
      conversationId: opts.conversationId,
      assetId: created.id,
    });

    // Obtain bytes: prefer the eager `bytes`, else the lazy `downloadBytes`
    // thunk (tg-client). The thunk must never throw; guard regardless so a
    // download error degrades to honest-pending instead of failing inbound.
    let bytes: Uint8Array | null = opts.bytes ?? null;
    if ((!bytes || bytes.byteLength === 0) && opts.downloadBytes) {
      bytes = await opts.downloadBytes().catch(() => null);
    }

    // '' = no stored object (NOT-NULL sentinel); set to real key on upload only.
    let s3Key = '';
    let sha256: string | null = null;
    let storedBytes = opts.media.bytes ?? null;

    if (bytes && bytes.byteLength > 0) {
      const store = getObjectStore();
      if (store) {
        await store.putObject(key, bytes, opts.media.mime);
        s3Key = key;
        sha256 = createHash('sha256').update(bytes).digest('hex');
        storedBytes = bytes.byteLength;
      } else {
        // Flag on but config absent. Honest-pending: no object was written, so
        // leave s3Key empty rather than point at a non-existent object.
        logger.warn(
          { conversationId: opts.conversationId },
          'inbound media: storage flag on but config absent; recorded metadata-only media_asset',
        );
      }
    } else {
      // No bytes (download unavailable / failed / empty). Honest-pending row.
      logger.warn(
        {
          conversationId: opts.conversationId,
          assetId: created.id,
          mediaClass: opts.media.className,
        },
        'inbound media: byte download unavailable; recorded metadata-only media_asset (s3Key empty)',
      );
    }

    const asset = await prisma.mediaAsset.update({
      where: { id: created.id },
      data: { s3Key, sha256, bytes: storedBytes },
    });

    logger.info(
      redact({
        event: 'media.persisted',
        conversationId: opts.conversationId,
        profileId,
        assetId: asset.id,
        kind: asset.kind,
        s3Key: asset.s3Key,
        hasBytes: sha256 !== null,
      }),
      'inbound media asset recorded',
    );
    return { persisted: s3Key !== '', assetId: asset.id, ...(s3Key === '' ? { degraded: 'no_bytes' } : {}) };
  } catch (err) {
    // NEVER fail inbound processing over media. Log + continue.
    logger.warn(
      {
        conversationId: opts.conversationId,
        err: (err as Error).message,
      },
      'inbound media persistence failed; degrading (inbound continues)',
    );
    return { persisted: false, degraded: 'error' };
  }
}

/**
 * Snapshot a raw response payload (verbatim reply text + any parsed JSON) to
 * object storage under a deterministic key (agency-sourcing-matching M6, task
 * 6.3 / spec: "raw response payloads SHALL also be snapshotted ... under a
 * deterministic key referenced from the profile data points"). Returns the
 * key so the caller can reference it from data points, or `null` when storage
 * is off / unavailable. DEGRADES SAFELY — extraction never fails over this.
 */
export async function snapshotRawPayload(opts: {
  conversationId: string;
  sourceMessageId: string;
  rawText: string;
  parsed?: unknown;
  /** When known, namespaces the key under the profile (N1). */
  profileId?: string | null;
}): Promise<string | null> {
  if (!getFeatureFlags().get('object_storage')) return null;
  const store = getObjectStore();
  if (!store) return null;

  const key = rawPayloadKey({
    conversationId: opts.conversationId,
    sourceMessageId: opts.sourceMessageId,
    profileId: opts.profileId ?? null,
  });
  try {
    const body = buildRawPayloadSnapshot(opts);
    await store.putObject(key, body, 'application/json');
    logger.info(
      { event: 'raw_payload.snapshot', conversationId: opts.conversationId, s3Key: key },
      'raw payload snapshot written',
    );
    return key;
  } catch (err) {
    logger.warn(
      { conversationId: opts.conversationId, err: (err as Error).message },
      'raw payload snapshot failed; degrading',
    );
    return null;
  }
}
