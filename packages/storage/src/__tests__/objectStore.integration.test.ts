import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectStore } from '../ObjectStore.js';
import { getObjectStore, resetObjectStore } from '../index.js';

const MINIO = {
  endpoint: 'http://localhost:9000',
  region: 'us-east-1',
  accessKey: 'minioadmin',
  secretKey: 'minioadmin123',
  bucket: 'outreach-media-test',
  forcePathStyle: true as const,
};

/**
 * Probe MinIO once; SKIP the live cases cleanly when it's unreachable so CI
 * without MinIO doesn't hard-fail (agency-sourcing-matching M6, task 6.5).
 */
async function minioReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${MINIO.endpoint}/minio/health/live`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

describe('ObjectStore against MinIO (integration)', () => {
  let reachable = false;
  let store: ObjectStore;

  beforeAll(async () => {
    reachable = await minioReachable();
    if (!reachable) return;
    store = new ObjectStore(MINIO);
    await store.ensureBucket();
  });

  it('puts an object and reads it back via a presigned GET URL', async () => {
    if (!reachable) {
      console.warn('MinIO unreachable at http://localhost:9000 — skipping live test');
      return;
    }
    const key = `bloggers/test-profile/asset-${Date.now()}`;
    const body = `hello-minio-${Math.random()}`;
    await store.putObject(key, body, 'text/plain');

    const url = await store.getPresignedGetUrl(key, 120);
    expect(url).toContain(MINIO.bucket);
    // The signed query must not leak the raw secret.
    expect(url).not.toContain(MINIO.secretKey);

    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);
  });

  it('issues a presigned PUT URL that accepts an upload', async () => {
    if (!reachable) return;
    const key = `bloggers/test-profile/put-${Date.now()}`;
    const putUrl = await store.getPresignedPutUrl(key, 'text/plain', 120);
    const body = 'uploaded-via-presigned-put';
    const putRes = await fetch(putUrl, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body,
    });
    expect(putRes.ok).toBe(true);

    const getUrl = await store.getPresignedGetUrl(key, 120);
    const getRes = await fetch(getUrl);
    expect(await getRes.text()).toBe(body);
  });
});

describe('storage degrades safely when unconfigured', () => {
  // Storage is now flag-agnostic (runtime-feature-flags M2): the
  // `object_storage` feature gate lives at the call sites, not in the storage
  // package. getObjectStore() returns null only when S3_* config is absent.
  afterAll(() => {
    resetObjectStore();
  });

  it('getObjectStore() returns null (no throw) when config is absent', () => {
    const prev = {
      key: process.env.S3_ACCESS_KEY,
      secret: process.env.S3_SECRET_KEY,
      bucket: process.env.S3_BUCKET,
    };
    delete process.env.S3_ACCESS_KEY;
    delete process.env.S3_SECRET_KEY;
    delete process.env.S3_BUCKET;
    resetObjectStore();
    try {
      expect(getObjectStore()).toBeNull();
    } finally {
      if (prev.key !== undefined) process.env.S3_ACCESS_KEY = prev.key;
      if (prev.secret !== undefined) process.env.S3_SECRET_KEY = prev.secret;
      if (prev.bucket !== undefined) process.env.S3_BUCKET = prev.bucket;
      resetObjectStore();
    }
  });
});
