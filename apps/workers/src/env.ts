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
  LOG_LEVEL: z.string().default('info'),
});

export const env = EnvZ.parse(process.env);
