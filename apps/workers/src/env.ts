import { z } from 'zod';

const EnvZ = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string(),
  ENCRYPTION_KEY: z.string().min(10),
  TG_API_ID: z.string().optional(),
  TG_API_HASH: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),
});

export const env = EnvZ.parse(process.env);
