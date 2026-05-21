// Env stubbing runs from vitest's setupFiles in apps/api/vitest.config.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Admin flags API (runtime-feature-flags M3, task 3.4).
 *
 * Exercises the real route + auth/role composition over `app.inject`:
 *  - admin PATCH → row updated (setEnabled), audit_log written, and
 *    publishFeatureFlagsChanged() called (cross-process invalidation);
 *  - operator/viewer PATCH → 403, no write, no publish;
 *  - admin GET → every registry key with resolved state + readiness hints.
 *
 * Prisma is mocked (no DB), the runtime accessor + publish are mocked (no
 * Redis), and audit is spied on.
 */

const prismaMock = vi.hoisted(() => ({
  featureFlag: {
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
  auditLog: { create: vi.fn() },
  endpoint: { count: vi.fn() },
  tgAccount: { count: vi.fn() },
  bloggerProfile: { count: vi.fn() },
  // setEnabled wraps the row upsert + audit_log insert in one transaction.
  $transaction: vi.fn((ops: Array<Promise<unknown>>) => Promise.all(ops)),
}));

vi.mock('@nosquare/db', () => ({ getPrisma: () => prismaMock }));

const flagState = vi.hoisted(() => ({
  campaign_types: false,
  agency_sourcing: false,
  object_storage: false,
  blogger_matching: false,
}) as Record<string, boolean>);

const publishMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('../../feature-flags.js', () => ({
  getFeatureFlags: () => ({ get: (k: string) => flagState[k] ?? false }),
  publishFeatureFlagsChanged: publishMock,
}));

import { registerAuth } from '../../auth/plugin.js';
import { registerErrorHandler } from '../../error-handler.js';
import { featureFlagsRoutes } from '../feature-flags.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await registerAuth(app);
  registerErrorHandler(app);
  await app.register(featureFlagsRoutes);
  await app.ready();
  return app;
}

function tokenFor(app: FastifyInstance, role: 'admin' | 'operator' | 'viewer'): string {
  return app.jwt.sign({ id: `u_${role}`, email: `${role}@x.io`, role });
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  flagState.campaign_types = false;
  flagState.agency_sourcing = false;
  flagState.object_storage = false;
  flagState.blogger_matching = false;
  prismaMock.featureFlag.findMany.mockResolvedValue([
    { key: 'campaign_types', description: 'Реестр типов' },
    { key: 'agency_sourcing', description: 'Агентский режим' },
    { key: 'object_storage', description: 'S3' },
    { key: 'blogger_matching', description: 'Подбор' },
  ]);
  prismaMock.endpoint.count.mockResolvedValue(0);
  prismaMock.tgAccount.count.mockResolvedValue(0);
  prismaMock.bloggerProfile.count.mockResolvedValue(0);
  prismaMock.auditLog.create.mockResolvedValue({});
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

describe('GET /feature-flags', () => {
  it('returns every registry key with resolved state + readiness', async () => {
    flagState.campaign_types = true; // resolved through the accessor
    const res = await app.inject({
      method: 'GET',
      url: '/feature-flags',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{
      key: string;
      enabled: boolean;
      description: string;
      readiness: { ready: boolean; hint?: string };
    }>;
    expect(body.map((f) => f.key).sort()).toEqual(
      ['agency_sourcing', 'blogger_matching', 'campaign_types', 'channel_discovery', 'object_storage'],
    );
    const ct = body.find((f) => f.key === 'campaign_types')!;
    expect(ct.enabled).toBe(true);
    expect(ct.readiness).toEqual({ ready: true }); // always ready
    // agency_sourcing not ready: no endpoints, no tg accounts
    const ag = body.find((f) => f.key === 'agency_sourcing')!;
    expect(ag.readiness.ready).toBe(false);
    expect(ag.readiness.hint).toBeTruthy();
    // blogger_matching: empty catalog hint
    const bm = body.find((f) => f.key === 'blogger_matching')!;
    expect(bm.readiness.ready).toBe(false);
    expect(bm.readiness.hint).toContain('каталог пуст');
    // object_storage: no S3 env in test → not ready, non-blocking hint
    const os = body.find((f) => f.key === 'object_storage')!;
    expect(os.readiness.ready).toBe(false);
  });

  it('rejects a non-admin (operator) with 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/feature-flags',
      headers: { authorization: `Bearer ${tokenFor(app, 'operator')}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a non-admin (viewer) with 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/feature-flags',
      headers: { authorization: `Bearer ${tokenFor(app, 'viewer')}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/feature-flags' });
    expect(res.statusCode).toBe(401);
  });
});

describe('PATCH /feature-flags/:key', () => {
  it('admin toggle updates the row, writes audit_log, and publishes invalidation', async () => {
    prismaMock.featureFlag.upsert.mockResolvedValue({
      key: 'agency_sourcing',
      enabled: true,
      description: 'Агентский режим',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: '/feature-flags/agency_sourcing',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { enabled: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ key: 'agency_sourcing', enabled: true });

    expect(prismaMock.featureFlag.upsert).toHaveBeenCalledTimes(1);
    expect(prismaMock.featureFlag.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: 'agency_sourcing' },
        update: { enabled: true, updatedById: 'u_admin' },
      }),
    );

    // Audit is written atomically with the row update (one $transaction).
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'u_admin',
          action: 'feature_flag.update',
          targetType: 'feature_flag',
          targetId: 'agency_sourcing',
          payload: { enabled: true },
        }),
      }),
    );

    expect(publishMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an operator with 403 and persists nothing', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/feature-flags/agency_sourcing',
      headers: { authorization: `Bearer ${tokenFor(app, 'operator')}` },
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(403);
    expect(prismaMock.featureFlag.upsert).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('rejects a viewer with 403', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/feature-flags/agency_sourcing',
      headers: { authorization: `Bearer ${tokenFor(app, 'viewer')}` },
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(403);
    expect(prismaMock.featureFlag.upsert).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated PATCH with 401', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/feature-flags/agency_sourcing',
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(401);
    expect(prismaMock.featureFlag.upsert).not.toHaveBeenCalled();
  });

  it('400s on an unknown flag key (closed registry)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/feature-flags/not_a_flag',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(400);
    expect(prismaMock.featureFlag.upsert).not.toHaveBeenCalled();
  });

  it('400s on an invalid body', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/feature-flags/agency_sourcing',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { enabled: 'yes' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('readiness evaluator — best-effort, never throws', () => {
  it('reports ready for agency_sourcing when an endpoint and a tg account exist', async () => {
    prismaMock.endpoint.count.mockResolvedValue(1);
    prismaMock.tgAccount.count.mockResolvedValue(1);
    prismaMock.bloggerProfile.count.mockResolvedValue(3);

    const res = await app.inject({
      method: 'GET',
      url: '/feature-flags',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    });
    const body = res.json() as Array<{ key: string; readiness: { ready: boolean } }>;
    expect(body.find((f) => f.key === 'agency_sourcing')!.readiness.ready).toBe(true);
    expect(body.find((f) => f.key === 'blogger_matching')!.readiness.ready).toBe(true);
  });

  it('reports not-ready (neutral hint) when a readiness query throws — no 500', async () => {
    prismaMock.endpoint.count.mockRejectedValue(new Error('db down'));
    prismaMock.bloggerProfile.count.mockRejectedValue(new Error('db down'));

    const res = await app.inject({
      method: 'GET',
      url: '/feature-flags',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ key: string; readiness: { ready: boolean; hint?: string } }>;
    const ag = body.find((f) => f.key === 'agency_sourcing')!;
    expect(ag.readiness.ready).toBe(false);
    expect(ag.readiness.hint).toBeTruthy();
  });
});
