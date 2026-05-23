import type { FastifyInstance } from 'fastify';
import { getRedis } from '../redis.js';
import { getPrisma } from '@nosquare/db';
import { getFeatureFlags } from '../feature-flags.js';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

  // Public, secret-free feature-flag snapshot so the web app can gate UI
  // (nav entries, campaign-type controls) on the same flags the API gates
  // routes with. Served from the DB-backed runtime accessor (resolved through
  // any env force-override). Only the agency-rollout flags are exposed —
  // never secrets or thresholds.
  app.get('/config', async () => {
    const snap = getFeatureFlags().snapshot();
    return {
      flags: {
        campaignTypes: snap.campaign_types,
        agencySourcing: snap.agency_sourcing,
        objectStorage: snap.object_storage,
        bloggerMatching: snap.blogger_matching,
      },
    };
  });

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
