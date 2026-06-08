import {
  bytesToDataUrl,
  ocrImageMime,
  OCR_MAX_ASSETS_PER_MESSAGE,
  OCR_MAX_BYTES,
  OCR_MAX_TEXT_CHARS,
} from '@nosquare/shared';
import { getObjectStore } from '@nosquare/storage';
import { getPrisma } from '@nosquare/db';
import { getFeatureFlags } from '../feature-flags.js';
import { logger } from '../logger.js';
import { runAgentSafe } from './run-agent-safe.js';

/**
 * Attachment OCR (attachment-ocr-ingestion). For a source message, OCR its
 * image attachments (vision via OpenRouter) once per asset and return the
 * recognized texts to feed back into the extractors. Double-gated
 * (attachment_ocr + object_storage); degrades safely — never throws.
 *
 * Single-run: an atomic claim (`updateMany WHERE ocr_status IN pending|failed
 * SET processing`) guards the sync on_inbound run and a queued re-run from
 * racing. `ok` assets reuse the cached `ocrText`.
 */
/** A `processing` OCR claim older than this is considered stranded (worker crash). */
const PROCESSING_STALE_MS = 5 * 60 * 1000;

export async function ocrMessageAttachments(opts: {
  conversationId: string;
  messageId: string;
}): Promise<string[]> {
  const flags = getFeatureFlags();
  if (!flags.get('attachment_ocr') || !flags.get('object_storage')) return [];

  const prisma = getPrisma();
  // Legacy media rows (created before `media_asset.message_id`) are linked only
  // by conversation + source TG message id, so also match those (codex).
  const msg = await prisma.message.findUnique({
    where: { id: opts.messageId },
    select: { tgMsgId: true },
  });
  const assets = await prisma.mediaAsset.findMany({
    where: {
      kind: { not: 'raw_payload' },
      OR: [
        { messageId: opts.messageId },
        ...(msg?.tgMsgId
          ? [{ conversationId: opts.conversationId, sourceTgMsgId: msg.tgMsgId }]
          : []),
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: OCR_MAX_ASSETS_PER_MESSAGE,
  });
  if (assets.length === 0) return [];

  const texts: string[] = [];
  for (const a of assets) {
    // Cached.
    if (a.ocrStatus === 'ok') {
      if (a.ocrText) texts.push(a.ocrText);
      continue;
    }
    if (a.ocrStatus === 'unsupported') continue;

    const mime = ocrImageMime(a.kind, a.mime);
    if (!mime || !a.s3Key) {
      await markStatus(a.id, 'unsupported');
      continue;
    }
    // Enforce the byte cap BEFORE downloading, using the stored size (codex), so
    // a known-oversized image never hits memory / the hot path.
    if (typeof a.bytes === 'number' && a.bytes > OCR_MAX_BYTES) {
      await markStatus(a.id, 'unsupported');
      continue;
    }

    // Atomic claim: only the worker that flips pending/failed (or a STALE
    // processing claim — a crashed worker) → processing runs OCR; a loser reuses
    // the final cached text. `ocrClaimedAt` distinguishes an active claim from a
    // stranded one.
    const staleBefore = new Date(Date.now() - PROCESSING_STALE_MS);
    const claim = await prisma.mediaAsset.updateMany({
      where: {
        id: a.id,
        OR: [
          { ocrStatus: 'pending' },
          { ocrStatus: 'failed' },
          { ocrStatus: null },
          { ocrStatus: 'processing', ocrClaimedAt: { lt: staleBefore } },
          { ocrStatus: 'processing', ocrClaimedAt: null },
        ],
      },
      data: { ocrStatus: 'processing', ocrClaimedAt: new Date() },
    });
    if (claim.count === 0) {
      const fresh = await prisma.mediaAsset.findUnique({
        where: { id: a.id },
        select: { ocrStatus: true, ocrText: true },
      });
      if (fresh?.ocrStatus === 'ok' && fresh.ocrText) texts.push(fresh.ocrText);
      continue;
    }

    try {
      const store = getObjectStore();
      if (!store) {
        await markStatus(a.id, 'failed');
        continue;
      }
      const bytes = await store.getObject(a.s3Key);
      if (bytes.byteLength > OCR_MAX_BYTES) {
        await markStatus(a.id, 'unsupported');
        continue;
      }
      const dataUrl = bytesToDataUrl(bytes, mime);
      const out = await runAgentSafe<{ text: string }>(
        'media_ocr_extractor',
        // Input persisted to agent_run is metadata only; the data-URL is
        // redacted by AgentRunner before persistence.
        { assetId: a.id, mime, sha256: a.sha256 ?? undefined, images: [{ url: dataUrl }] },
        { conversationId: opts.conversationId },
      );
      if (!out) {
        await markStatus(a.id, 'failed');
        continue;
      }
      const text = (out.text ?? '').slice(0, OCR_MAX_TEXT_CHARS);
      await prisma.mediaAsset.update({
        where: { id: a.id },
        data: { ocrText: text, ocrStatus: 'ok' },
      });
      if (text.trim()) texts.push(text);
    } catch (err) {
      logger.warn(
        { event: 'attachment_ocr.failed', assetId: a.id, err: (err as Error).message },
        'attachment OCR failed; marking failed',
      );
      await markStatus(a.id, 'failed');
    }
  }
  return texts;
}

async function markStatus(id: string, status: string): Promise<void> {
  await getPrisma()
    .mediaAsset.update({ where: { id }, data: { ocrStatus: status } })
    .catch(() => undefined);
}
