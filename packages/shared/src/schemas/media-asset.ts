import { z } from 'zod';

/**
 * S3-backed media asset (agency-sourcing-matching change). Files bloggers
 * send (media kits, stat screenshots) and raw-payload snapshots, linked to a
 * conversation and/or blogger profile.
 */
export const MediaAssetKindZ = z.enum([
  'media_kit',
  'screenshot',
  'document',
  'image',
  'video',
  'raw_payload',
  'other',
]);

export const MediaAssetZ = z.object({
  id: z.string(),
  conversationId: z.string().nullable(),
  profileId: z.string().nullable(),
  kind: MediaAssetKindZ,
  s3Key: z.string(),
  mime: z.string().nullable(),
  bytes: z.number().int().nullable(),
  sha256: z.string().nullable(),
  sourceTgMsgId: z.string().nullable(),
  createdAt: z.string(),
});

/** Presigned URL response surfaced to the UI for download/upload. */
export const PresignedUrlZ = z.object({
  url: z.string().url(),
  expiresInSeconds: z.number().int().positive(),
});

export type MediaAssetKind = z.infer<typeof MediaAssetKindZ>;
export type MediaAsset = z.infer<typeof MediaAssetZ>;
export type PresignedUrl = z.infer<typeof PresignedUrlZ>;
