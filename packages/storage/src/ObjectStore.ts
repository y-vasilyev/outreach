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
    } catch {
      // Most likely 404 (no bucket) or 403; try to create it. MinIO dev
      // buckets are cheap to create idempotently.
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        return true;
      } catch {
        return false;
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
