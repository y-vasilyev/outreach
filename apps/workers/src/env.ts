import { z } from 'zod';

const EnvZ = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string(),
  ENCRYPTION_KEY: z.string().min(10),
  TG_API_ID: z.string().optional(),
  TG_API_HASH: z.string().optional(),
  TG_SESSION_STRING: z.string().optional(),
  TG_BOOTSTRAP_ACCOUNT_ID: z.string().default('parser-default'),
  TG_PROXY_TYPE: z.enum(['socks5', 'mtproxy', '']).optional(),
  TG_PROXY_IP: z.string().optional(),
  TG_PROXY_PORT: z.coerce.number().int().optional(),
  TG_PROXY_USERNAME: z.string().optional(),
  TG_PROXY_PASSWORD: z.string().optional(),
  TG_PROXY_SECRET: z.string().optional(),
  TG_PROXY_TIMEOUT_SEC: z.coerce.number().int().min(1).max(120).optional(),
  TG_PROXY_FORCE_PORT_443: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  LOG_LEVEL: z.string().default('info'),
  // Object storage (S3 / MinIO). Optional — only consumed when
  // ENABLE_OBJECT_STORAGE is on; storage degrades to a no-op when absent.
  // Read by packages/storage via loadStorageConfig(process.env); kept here so
  // a misconfigured prod surfaces in validation rather than at first inbound.
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.string().optional(),
});

export const env = EnvZ.parse(process.env);
