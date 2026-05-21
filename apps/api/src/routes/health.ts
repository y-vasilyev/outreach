import type { FastifyInstance } from 'fastify';
import { flags } from '@nosquare/shared';
import { getRedis } from '../redis.js';
import { getPrisma } from '@nosquare/db';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

  // Public, secret-free feature-flag snapshot so the web app can gate UI
  // (nav entries, campaign-type controls) on the same flags the API uses to
  // register routes. Only the agency-rollout flags are exposed — never secrets
  // or thresholds.
  app.get('/config', async () => ({
    flags: {
      campaignTypes: flags.ENABLE_CAMPAIGN_TYPES,
      agencySourcing: flags.ENABLE_AGENCY_SOURCING,
      objectStorage: flags.ENABLE_OBJECT_STORAGE,
      bloggerMatching: flags.ENABLE_BLOGGER_MATCHING,
    },
  }));

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
