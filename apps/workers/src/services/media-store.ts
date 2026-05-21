import { createHash } from 'node:crypto';
import { flags, redact, type MediaAssetKind } from '@nosquare/shared';
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
 * tg-client does not download media bytes (see IncomingMedia doc), so we record
 * the metadata-only asset row referencing the source TG message. When/if a
 * byte-download path lands in tg-client, pass `bytes` here to also upload.
 */
export async function persistInboundMedia(opts: {
  conversationId: string;
  channelId?: string | null;
  sourceTgMsgId?: string | null;
  media: InboundMediaMeta;
  /** Downloaded bytes, when available (tg-client currently provides none). */
  bytes?: Uint8Array;
}): Promise<{ persisted: boolean; assetId?: string; degraded?: string }> {
  if (!flags.ENABLE_OBJECT_STORAGE) {
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
    // Create the row first so we have a stable assetId for the key (and so the
    // asset is recorded even if the byte upload below degrades). s3Key is set
    // to the deterministic key we'd upload to; bytes/sha256 stay null when no
    // bytes were downloaded.
    const created = await prisma.mediaAsset.create({
      data: {
        conversationId: opts.conversationId,
        profileId,
        kind: assetKind,
        // Placeholder; rewritten below once we know the id-derived key.
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

    let sha256: string | null = null;
    let storedBytes = opts.media.bytes ?? null;

    if (opts.bytes && opts.bytes.byteLength > 0) {
      const store = getObjectStore();
      if (store) {
        await store.putObject(key, opts.bytes, opts.media.mime);
        sha256 = createHash('sha256').update(opts.bytes).digest('hex');
        storedBytes = opts.bytes.byteLength;
      } else {
        logger.warn(
          { conversationId: opts.conversationId },
          'inbound media: storage flag on but config absent; recorded asset row only',
        );
      }
    } else {
      // No bytes available (tg-client doesn't download). Record metadata-only.
      logger.warn(
        {
          conversationId: opts.conversationId,
          assetId: created.id,
          mediaClass: opts.media.className,
        },
        'inbound media: byte download unavailable; recorded metadata-only media_asset',
      );
    }

    const asset = await prisma.mediaAsset.update({
      where: { id: created.id },
      data: { s3Key: key, sha256, bytes: storedBytes },
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
    return { persisted: true, assetId: asset.id };
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
}): Promise<string | null> {
  if (!flags.ENABLE_OBJECT_STORAGE) return null;
  const store = getObjectStore();
  if (!store) return null;

  const key = rawPayloadKey({
    conversationId: opts.conversationId,
    sourceMessageId: opts.sourceMessageId,
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
