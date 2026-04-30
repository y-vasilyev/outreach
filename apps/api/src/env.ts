import { z } from 'zod';

const EnvZ = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_PORT: z.coerce.number().int().default(4000),
  API_HOST: z.string().default('0.0.0.0'),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  PUBLIC_API_URL: z.string().default('http://localhost:4000'),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string(),
  JWT_SECRET: z.string().min(16),
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
  LOG_MESSAGE_BODIES: z.string().default('false'),
});

export const env = EnvZ.parse(process.env);
export type Env = z.infer<typeof EnvZ>;
