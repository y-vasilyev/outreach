// Env stubbing runs from vitest's setupFiles in apps/api/vitest.config.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Settings → Exchange rates API (price-normalization-v2): admin-only CRUD over
 * the current rate per currency; an upsert/delete enqueues offer-renormalize
 * for that currency. Prisma + queues mocked.
 */

const prismaMock = vi.hoisted(() => ({
  exchangeRate: {
    findMany: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

vi.mock('@nosquare/db', () => ({ getPrisma: () => prismaMock }));

const queueAdd = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('../../queues.js', () => ({
  getQueues: () => ({ offerRenormalize: { add: queueAdd } }),
}));

import { registerAuth } from '../../auth/plugin.js';
import { registerErrorHandler } from '../../error-handler.js';
import { exchangeRatesRoutes } from '../exchange-rates.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await registerAuth(app);
  registerErrorHandler(app);
  await app.register(exchangeRatesRoutes);
  await app.ready();
  return app;
}

function tokenFor(app: FastifyInstance, role: 'admin' | 'operator' | 'viewer'): string {
  return app.jwt.sign({ id: `u_${role}`, email: `${role}@x.io`, role });
}

const rateRow = {
  currency: 'USD',
  rateToRub: 92.4,
  asOf: new Date('2026-06-01T00:00:00Z'),
  source: 'manual',
  updatedById: 'u_admin',
  updatedAt: new Date('2026-06-10T00:00:00Z'),
};

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  prismaMock.exchangeRate.findMany.mockResolvedValue([rateRow]);
  prismaMock.exchangeRate.upsert.mockResolvedValue(rateRow);
  prismaMock.exchangeRate.deleteMany.mockResolvedValue({ count: 1 });
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

describe('exchange-rates routes', () => {
  it('admin PUT upserts the rate and enqueues renormalize for the currency', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/settings/exchange-rates/usd',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { rateToRub: 92.4 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ currency: 'USD', rateToRub: 92.4 });
    // Param currency is normalized to uppercase before hitting the DB.
    const upsertArg = prismaMock.exchangeRate.upsert.mock.calls[0]![0] as {
      where: { currency: string };
    };
    expect(upsertArg.where.currency).toBe('USD');
    expect(queueAdd).toHaveBeenCalledWith('renormalize', { currency: 'USD' });
  });

  it('non-admin writes are 403 with no DB write and no enqueue', async () => {
    for (const role of ['operator', 'viewer'] as const) {
      const res = await app.inject({
        method: 'PUT',
        url: '/settings/exchange-rates/USD',
        headers: { authorization: `Bearer ${tokenFor(app, role)}` },
        payload: { rateToRub: 90 },
      });
      expect(res.statusCode).toBe(403);
    }
    expect(prismaMock.exchangeRate.upsert).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('RUB and malformed codes are rejected', async () => {
    for (const bad of ['RUB', 'DOLLARS', 'U1']) {
      const res = await app.inject({
        method: 'PUT',
        url: `/settings/exchange-rates/${bad}`,
        headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
        payload: { rateToRub: 1 },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('DELETE removes the rate and re-enqueues renormalize (rows drop to unnormalized)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/settings/exchange-rates/USD',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    });
    expect(res.statusCode).toBe(204);
    expect(queueAdd).toHaveBeenCalledWith('renormalize', { currency: 'USD' });
  });

  it('GET lists rates (admin only)', async () => {
    const ok = await app.inject({
      method: 'GET',
      url: '/settings/exchange-rates',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual([
      expect.objectContaining({ currency: 'USD', rateToRub: 92.4 }),
    ]);
    const forbidden = await app.inject({
      method: 'GET',
      url: '/settings/exchange-rates',
      headers: { authorization: `Bearer ${tokenFor(app, 'viewer')}` },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
