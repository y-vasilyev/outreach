// Env stubbing runs from vitest's setupFiles in apps/api/vitest.config.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Route-level contract for `GET /conversations`. The service-layer test in
 * conversations-list-filters.test.ts pins the Prisma `where` composition;
 * this file pins the HTTP envelope: status codes, auth, ZodError → 400.
 * inbox-campaign-filter change.
 */

const prismaMock = vi.hoisted(() => ({
  conversation: { findMany: vi.fn() },
  message: { findMany: vi.fn() },
  suggestion: { groupBy: vi.fn() },
}));

vi.mock('@nosquare/db', () => ({ getPrisma: () => prismaMock, Prisma: {} }));
vi.mock('../../queues.js', () => ({ getQueues: () => ({ tgSend: { add: vi.fn() } }) }));
vi.mock('../../realtime/io.js', () => ({ emitToRoom: vi.fn() }));
vi.mock('../../services/agents.js', () => ({
  getAgentRunner: () => ({ run: vi.fn() }),
}));
// `GET /conversations/:id` triggers a TG sync; we don't exercise that
// route here but the import graph pulls it in.
vi.mock('../../services/conversation-sync.js', () => ({
  syncOneWithBudget: vi.fn(async () => {}),
}));

import { registerAuth } from '../../auth/plugin.js';
import { registerErrorHandler } from '../../error-handler.js';
import { conversationsRoutes } from '../conversations.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await registerAuth(app);
  registerErrorHandler(app);
  await app.register(conversationsRoutes);
  await app.ready();
  return app;
}

function tokenFor(app: FastifyInstance, role: 'admin' | 'operator' | 'viewer'): string {
  return app.jwt.sign({ id: `u_${role}`, email: `${role}@x.io`, role });
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  prismaMock.conversation.findMany.mockResolvedValue([]);
  prismaMock.message.findMany.mockResolvedValue([]);
  prismaMock.suggestion.groupBy.mockResolvedValue([]);
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

describe('GET /conversations — HTTP contract', () => {
  it('viewer can list with a campaignId filter (spec: auth unchanged by filters)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/conversations?campaignId=camp-1',
      headers: { authorization: `Bearer ${tokenFor(app, 'viewer')}` },
    });
    expect(res.statusCode).toBe(200);
    const where = prismaMock.conversation.findMany.mock.calls[0]?.[0]?.where;
    expect(where).toEqual({ campaignId: 'camp-1' });
  });

  it('rejects overlong q with 400 (Zod boundary) and never hits Prisma', async () => {
    const longQ = 'a'.repeat(201);
    const res = await app.inject({
      method: 'GET',
      url: `/conversations?q=${longQ}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'operator')}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR' },
    });
    expect(prismaMock.conversation.findMany).not.toHaveBeenCalled();
  });

  it('empty filter params are accepted (no enum error) and treated as absent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/conversations?status=&mode=&campaignId=',
      headers: { authorization: `Bearer ${tokenFor(app, 'operator')}` },
    });
    expect(res.statusCode).toBe(200);
    expect(prismaMock.conversation.findMany.mock.calls[0]?.[0]?.where).toEqual({});
  });

  it('unauthenticated request is rejected with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/conversations' });
    expect(res.statusCode).toBe(401);
    expect(prismaMock.conversation.findMany).not.toHaveBeenCalled();
  });

  it('combines campaignId and q into one query', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/conversations?campaignId=camp-1&q=acme',
      headers: { authorization: `Bearer ${tokenFor(app, 'operator')}` },
    });
    expect(res.statusCode).toBe(200);
    const where = prismaMock.conversation.findMany.mock.calls[0]?.[0]?.where as
      | { campaignId?: string; OR?: unknown[] }
      | undefined;
    expect(where?.campaignId).toBe('camp-1');
    expect(Array.isArray(where?.OR)).toBe(true);
    expect(where?.OR?.length).toBe(3);
  });
});
