import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageConfig } from './config.js';

const DEFAULT_TTL_SECONDS = 300;

/**
 * Thin wrapper over the S3 SDK for S3-compatible object storage (MinIO in dev,
 * any S3 in prod). Construct only when `ENABLE_OBJECT_STORAGE` is on — see
 * `getObjectStore()`. Holds the bucket name and a configured client; never
 * logs its config (credentials).
 */
export class ObjectStore {
  private readonly client: S3Client;
  readonly bucket: string;
  /** Memoized one-time bucket-ensure, so the first putObject creates it. */
  private bucketEnsured: Promise<boolean> | null = null;

  constructor(config: StorageConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      // For MinIO/other S3-compatible endpoints. Omitted → real AWS.
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
    });
  }

  /** Upload bytes under `key`. */
  async putObject(
    key: string,
    body: Uint8Array | Buffer | string,
    contentType?: string,
  ): Promise<void> {
    // N2: ensure the bucket exists exactly once per instance before the first
    // upload (MinIO dev buckets aren't pre-created). Memoized so concurrent
    // puts share one ensure; a failed ensure doesn't hard-block the put — the
    // put itself surfaces the real error.
    if (!this.bucketEnsured) {
      this.bucketEnsured = this.ensureBucket();
    }
    await this.bucketEnsured;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ...(contentType ? { ContentType: contentType } : {}),
      }),
    );
  }

  /** Issue a short-lived presigned GET URL the client fetches directly. */
  async getPresignedGetUrl(key: string, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
  }

  /** Issue a short-lived presigned PUT URL for a client-side upload. */
  async getPresignedPutUrl(
    key: string,
    contentType?: string,
    ttlSeconds = DEFAULT_TTL_SECONDS,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(contentType ? { ContentType: contentType } : {}),
      }),
      { expiresIn: ttlSeconds },
    );
  }

  /**
   * Liveness probe: confirms the bucket is reachable, creating it if missing.
   * Returns true on success. Callers in the inbound path must treat a `false`
   * / throw as "degrade and continue", never as a hard failure.
   */
  async ensureBucket(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch (err) {
      // N2: narrow — only a genuine "bucket missing" (404 / NotFound /
      // NoSuchBucket) warrants a create. A 403 (permission) or any other error
      // is NOT masked: re-throw so a misconfigured credential / policy surfaces
      // instead of being swallowed as "couldn't ensure".
      if (!isBucketMissing(err)) throw err;
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        return true;
      } catch (createErr) {
        // A concurrent create (BucketAlreadyOwnedByYou / BucketAlreadyExists)
        // means the bucket is in fact present — treat as success. Anything else
        // propagates so the caller sees the real failure.
        if (isBucketAlreadyExists(createErr)) return true;
        throw createErr;
      }
    }
  }

  /** Lightweight health check used by callers before attempting a put. */
  async health(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch {
      return false;
    }
  }
}

/** S3/MinIO error shape — name + HTTP status hang off the SDK error object. */
interface S3LikeError {
  name?: string;
  Code?: string;
  $metadata?: { httpStatusCode?: number };
}

/** True only for a genuine "bucket does not exist" error (404 / NoSuchBucket). */
function isBucketMissing(err: unknown): boolean {
  const e = (err ?? {}) as S3LikeError;
  const status = e.$metadata?.httpStatusCode;
  const name = e.name ?? e.Code ?? '';
  if (status === 404) return true;
  return name === 'NotFound' || name === 'NoSuchBucket';
}

/** True when a create raced and the bucket already exists (owned by us). */
function isBucketAlreadyExists(err: unknown): boolean {
  const e = (err ?? {}) as S3LikeError;
  const name = e.name ?? e.Code ?? '';
  return name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists';
}
