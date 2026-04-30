import type { FastifyInstance } from 'fastify';
import { getRedis } from '../redis.js';
import { getPrisma } from '@nosquare/db';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

  app.get('/health/deep', async () => {
    const checks: Record<string, { ok: boolean; error?: string }> = {};
    try {
      const r = getRedis();
      await r.ping();
      checks.redis = { ok: true };
    } catch (e) {
      checks.redis = { ok: false, error: String(e) };
    }
    try {
      await getPrisma().$queryRaw`SELECT 1`;
      checks.postgres = { ok: true };
    } catch (e) {
      checks.postgres = { ok: false, error: String(e) };
    }
    return { ok: Object.values(checks).every((c) => c.ok), checks };
  });
}
