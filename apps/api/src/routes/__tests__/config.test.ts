// Env stubbing runs from vitest's setupFiles in apps/api/vitest.config.ts.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Public `GET /config` flag snapshot (fix-prod-console-errors).
 *
 * Pins that the snapshot mirrors the DB-backed flag state and, critically,
 * that it now exposes `dataCollectionHud` so the web can gate the inbox
 * data-collection HUD query and avoid a per-conversation 404 while off.
 */

const snap = vi.hoisted(() => ({
  current: {
    campaign_types: false,
    agency_sourcing: false,
    object_storage: false,
    blogger_matching: false,
    channel_discovery: false,
    data_collection_hud: false,
  } as Record<string, boolean>,
}));

vi.mock('../../feature-flags.js', () => ({
  getFeatureFlags: () => ({ snapshot: () => snap.current }),
}));
vi.mock('../../redis.js', () => ({ getRedis: () => ({ ping: vi.fn() }) }));
vi.mock('@nosquare/db', () => ({ getPrisma: () => ({ $queryRaw: vi.fn() }) }));

import { healthRoutes } from '../health.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(healthRoutes);
  await app.ready();
  return app;
}

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

describe('GET /config', () => {
  it('exposes dataCollectionHud reflecting the DB flag state (off)', async () => {
    snap.current.data_collection_hud = false;
    const res = await app.inject({ method: 'GET', url: '/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json().flags).toMatchObject({ dataCollectionHud: false });
  });

  it('reflects the flag when toggled on', async () => {
    snap.current.data_collection_hud = true;
    const res = await app.inject({ method: 'GET', url: '/config' });
    expect(res.json().flags.dataCollectionHud).toBe(true);
  });
});
