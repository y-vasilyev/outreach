import { z } from 'zod';

/**
 * S3 / object-storage connection config (agency-sourcing-matching M6, D5).
 *
 * The whole storage subsystem is gated behind `ENABLE_OBJECT_STORAGE`. These
 * vars are only *required* when the flag is on — `loadStorageConfig` returns
 * `null` (rather than throwing) when the flag is off or the bucket isn't
 * configured, so dev/CI without MinIO degrades to a no-op instead of crashing
 * boot.
 *
 * `S3_FORCE_PATH_STYLE=true` is needed for MinIO (and most non-AWS S3
 * implementations) which don't support virtual-hosted-style bucket subdomains.
 */
export const StorageConfigZ = z.object({
  endpoint: z.string().url().optional(),
  region: z.string().default('us-east-1'),
  accessKey: z.string().min(1),
  secretKey: z.string().min(1),
  bucket: z.string().min(1),
  forcePathStyle: z.boolean().default(true),
});

export type StorageConfig = z.infer<typeof StorageConfigZ>;

function parseBool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt;
  return v === 'true' || v === '1';
}

/**
 * Read storage config from `process.env`. Returns `null` when the minimum
 * required vars (access key, secret, bucket) are absent, so callers can decide
 * to degrade gracefully rather than crash. NEVER logs the parsed config — it
 * carries credentials.
 */
export function loadStorageConfig(
  source: NodeJS.ProcessEnv = process.env,
): StorageConfig | null {
  const accessKey = source.S3_ACCESS_KEY;
  const secretKey = source.S3_SECRET_KEY;
  const bucket = source.S3_BUCKET;
  if (!accessKey || !secretKey || !bucket) return null;

  return StorageConfigZ.parse({
    endpoint: source.S3_ENDPOINT || undefined,
    region: source.S3_REGION || 'us-east-1',
    accessKey,
    secretKey,
    bucket,
    forcePathStyle: parseBool(source.S3_FORCE_PATH_STYLE, true),
  });
}
