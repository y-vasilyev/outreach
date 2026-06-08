// Env stubbing runs from vitest's setupFiles in apps/api/vitest.config.ts.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Data-collection HUD route (`GET /conversations/:id/data-collection`) —
 * data-collection-hud-target-fields change, Phase 1.
 *
 * Pins:
 *   - feature-flag gate (404 when off, response when on);
 *   - per-target state classification (`answered`/`asked`/`missing`/`stale`);
 *   - target-local freshness so `geo` and `audience_demographics` don't
 *     contaminate each other.
 */

const prismaMock = vi.hoisted(() => ({
  conversation: { findUnique: vi.fn() },
  bloggerProfile: { findUnique: vi.fn() },
  suggestion: { findMany: vi.fn() },
  message: { findMany: vi.fn() },
}));

const flagState = vi.hoisted(() => ({ current: { data_collection_hud: false } }));

vi.mock('@nosquare/db', () => ({ getPrisma: () => prismaMock, Prisma: {} }));
vi.mock('../../feature-flags.js', () => ({
  getFeatureFlags: () => ({ get: (k: string) => flagState.current[k as 'data_collection_hud'] ?? false }),
}));
vi.mock('../../queues.js', () => ({ getQueues: () => ({ tgSend: { add: vi.fn() } }) }));
vi.mock('../../realtime/io.js', () => ({ emitToRoom: vi.fn() }));
vi.mock('../../services/agents.js', () => ({
  getAgentRunner: () => ({ run: vi.fn() }),
}));
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

const NOW = new Date('2026-06-04T00:00:00.000Z');

function freshDate(daysAgo: number): Date {
  return new Date(NOW.getTime() - daysAgo * 86_400_000);
}

// Pin the system clock so the HUD's freshness / TTL classification is
// deterministic. The HUD service goes through `buildHudTargetRow` which
// defaults `now` to `new Date()` — fake timers ensure that default
// resolves to our pinned NOW regardless of when the test runs.
beforeAll(() => {
  vi.useFakeTimers({ now: NOW, shouldAdvanceTime: false });
});
afterAll(() => {
  vi.useRealTimers();
});

beforeEach(async () => {
  vi.clearAllMocks();
  flagState.current.data_collection_hud = false;
  prismaMock.conversation.findUnique.mockResolvedValue({
    id: 'conv-1',
    contact: { channelId: 'ch-1' },
    campaign: {
      goal: { target_data_points: ['rate_card', 'reach', 'audience_demographics', 'geo'] },
      type: { key: 'agency_sourcing' },
    },
  });
  prismaMock.bloggerProfile.findUnique.mockResolvedValue({ dataPoints: [] });
  prismaMock.suggestion.findMany.mockResolvedValue([]);
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

describe('GET /conversations/:id/data-collection', () => {
  it('returns 404 when the data_collection_hud flag is off', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/conversations/conv-1/data-collection',
      headers: { authorization: `Bearer ${tokenFor(app, 'operator')}` },
    });
    expect(res.statusCode).toBe(404);
    // The 404 must come from `requireFeature` BEFORE the service runs.
    expect(prismaMock.conversation.findUnique).not.toHaveBeenCalled();
  });

  it('returns 401 unauthenticated even when the flag is on', async () => {
    flagState.current.data_collection_hud = true;
    const res = await app.inject({
      method: 'GET',
      url: '/conversations/conv-1/data-collection',
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns an empty HUD (campaignTypeKey null) for an unsupported campaign type', async () => {
    flagState.current.data_collection_hud = true;
    // A CustDev campaign is not a HUD-supported type: the endpoint must NOT
    // fall back to the agency default target set (which would surface
    // commercial fields on a non-agency conversation).
    prismaMock.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      contact: { channelId: 'ch-1' },
      campaign: { id: 'camp-1', goal: {}, type: { key: 'custdev' } },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/conversations/conv-1/data-collection',
      headers: { authorization: `Bearer ${tokenFor(app, 'operator')}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { campaignTypeKey: string | null; targets: unknown[] };
    expect(body.campaignTypeKey).toBeNull();
    expect(body.targets).toEqual([]);
    // Must not even query the profile when the type is unsupported.
    expect(prismaMock.bloggerProfile.findUnique).not.toHaveBeenCalled();
  });

  it('classifies a fresh ProfileDataPoint as answered with provenance', async () => {
    flagState.current.data_collection_hud = true;
    prismaMock.bloggerProfile.findUnique.mockResolvedValue({
      dataPoints: [
        {
          field: 'rate.post',
          value: 15000,
          capturedAt: freshDate(10),
          sourceMessageId: 'msg-1',
        },
      ],
    });
    const res = await app.inject({
      method: 'GET',
      url: '/conversations/conv-1/data-collection',
      headers: { authorization: `Bearer ${tokenFor(app, 'viewer')}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { campaignTypeKey: string; targets: Array<Record<string, unknown>> };
    expect(body.campaignTypeKey).toBe('agency_sourcing');
    const rateCard = body.targets.find((t) => t.key === 'rate_card');
    expect(rateCard?.state).toBe('answered');
    expect((rateCard?.current as { value: number }).value).toBe(15000);
    expect((rateCard?.current as { sourceMessageId: string }).sourceMessageId).toBe('msg-1');
    expect((rateCard?.freshness as { stale: boolean }).stale).toBe(false);
  });

  it('resolves field-shaped campaign target data points instead of rendering an empty HUD', async () => {
    flagState.current.data_collection_hud = true;
    prismaMock.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      contact: { channelId: 'ch-1' },
      campaign: {
        goal: { target_data_points: ['rate.post', 'views.avg', 'audience.geo.ru'] },
        type: { key: 'agency_sourcing' },
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/conversations/conv-1/data-collection',
      headers: { authorization: `Bearer ${tokenFor(app, 'viewer')}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { targets: Array<{ key: string }> };
    expect(body.targets.map((t) => t.key)).toEqual(['rate_card', 'reach', 'geo']);
  });

  it('classifies an aged ProfileDataPoint as stale', async () => {
    flagState.current.data_collection_hud = true;
    prismaMock.bloggerProfile.findUnique.mockResolvedValue({
      dataPoints: [
        {
          field: 'rate.post',
          value: 15000,
          capturedAt: freshDate(120), // > 90d rate-card TTL
          sourceMessageId: null,
        },
      ],
    });
    const res = await app.inject({
      method: 'GET',
      url: '/conversations/conv-1/data-collection',
      headers: { authorization: `Bearer ${tokenFor(app, 'viewer')}` },
    });
    const body = res.json() as { targets: Array<Record<string, unknown>> };
    const rateCard = body.targets.find((t) => t.key === 'rate_card');
    expect(rateCard?.state).toBe('stale');
    expect((rateCard?.freshness as { stale: boolean }).stale).toBe(true);
  });

  it('classifies as asked when no data point exists but a suggestion targets the field', async () => {
    flagState.current.data_collection_hud = true;
    prismaMock.suggestion.findMany.mockResolvedValue([
      {
        meta: { targetField: 'geo' },
        createdAt: freshDate(0.01), // ~15 min ago
      },
    ]);
    const res = await app.inject({
      method: 'GET',
      url: '/conversations/conv-1/data-collection',
      headers: { authorization: `Bearer ${tokenFor(app, 'viewer')}` },
    });
    const body = res.json() as { targets: Array<Record<string, unknown>> };
    const geo = body.targets.find((t) => t.key === 'geo');
    expect(geo?.state).toBe('asked');
    expect((geo as { lastAskedAt: string }).lastAskedAt).toBeDefined();
  });

  it('keeps audience_demographics and geo independent (target-local freshness)', async () => {
    flagState.current.data_collection_hud = true;
    prismaMock.bloggerProfile.findUnique.mockResolvedValue({
      dataPoints: [
        {
          field: 'audience.geo',
          value: { RU: 0.7, KZ: 0.2 },
          capturedAt: freshDate(5),
          sourceMessageId: 'm-geo',
        },
      ],
    });
    const res = await app.inject({
      method: 'GET',
      url: '/conversations/conv-1/data-collection',
      headers: { authorization: `Bearer ${tokenFor(app, 'viewer')}` },
    });
    const body = res.json() as { targets: Array<Record<string, unknown>> };
    const geo = body.targets.find((t) => t.key === 'geo');
    const audience = body.targets.find((t) => t.key === 'audience_demographics');
    expect(geo?.state).toBe('answered');
    expect(audience?.state).toBe('missing');
  });

  it('returns an empty target list when the conversation has no campaign-resolved targets', async () => {
    flagState.current.data_collection_hud = true;
    prismaMock.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      contact: { channelId: null },
      // No campaign → no effective target list.
      campaign: null,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/conversations/conv-1/data-collection',
      headers: { authorization: `Bearer ${tokenFor(app, 'viewer')}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ campaignTypeKey: null, targets: [] });
  });

  it('returns 404 when the conversation does not exist (and the flag is on)', async () => {
    flagState.current.data_collection_hud = true;
    prismaMock.conversation.findUnique.mockResolvedValue(null);
    const res = await app.inject({
      method: 'GET',
      url: '/conversations/missing/data-collection',
      headers: { authorization: `Bearer ${tokenFor(app, 'viewer')}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
