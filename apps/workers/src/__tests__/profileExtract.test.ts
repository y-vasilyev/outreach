import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * profile-extract worker (agency-sourcing-matching M5, task 5.2/5.5): runs the
 * two extractors, persists data points linked to the channel's BloggerProfile
 * (created on first sight), attributes them to the inbound Message.id, and
 * re-derives the standardized profile via the deterministic roll-up.
 */
const mocks = vi.hoisted(() => {
  const prisma = {
    conversation: { findUnique: vi.fn() },
    message: { findMany: vi.fn() },
    bloggerProfile: { upsert: vi.fn(), update: vi.fn() },
    profileDataPoint: { create: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(),
  };
  const runAgentSafe = vi.fn();
  return { prisma, runAgentSafe };
});

vi.mock('@nosquare/db', () => ({ getPrisma: () => mocks.prisma, Prisma: { JsonNull: null } }));
vi.mock('bullmq', () => ({ Worker: class {} }));
vi.mock('../redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../services/run-agent-safe.js', () => ({ runAgentSafe: mocks.runAgentSafe }));

import { handleProfileExtract } from '../queues/profile-extract.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.conversation.findUnique.mockResolvedValue({
    id: 'conv1',
    contact: { id: 'c1', channelId: 'ch1', channel: { id: 'ch1', title: 'X', language: 'ru' } },
  });
  mocks.prisma.message.findMany.mockResolvedValue([
    { id: 'm1', text: 'пост 15000', direction: 'in_', createdAt: new Date('2026-05-01T00:00:00Z') },
    { id: 'm2', text: 'охваты сторис 12к', direction: 'in_', createdAt: new Date('2026-05-02T00:00:00Z') },
  ]);
  mocks.prisma.bloggerProfile.upsert.mockResolvedValue({ id: 'prof1', channelId: 'ch1' });
  mocks.prisma.bloggerProfile.update.mockResolvedValue({});
  mocks.prisma.profileDataPoint.create.mockResolvedValue({});
  mocks.prisma.$transaction.mockImplementation(
    async (fn: (tx: typeof mocks.prisma) => Promise<unknown>) => fn(mocks.prisma),
  );
});

describe('handleProfileExtract', () => {
  it('persists data points from both extractors and rolls up the profile', async () => {
    mocks.runAgentSafe.mockImplementation(async (name: string) => {
      if (name === 'rate_card_extractor') {
        return { data_points: [{ field: 'rate.post', value: 15000, unit: 'RUB', confidence: 0.9, rawSnippet: 'пост 15000' }] };
      }
      if (name === 'audience_stats_extractor') {
        return { data_points: [{ field: 'reach.story', value: 12000, confidence: 0.85, rawSnippet: 'охваты сторис 12к' }] };
      }
      return null;
    });
    // The roll-up reads back all persisted points.
    mocks.prisma.profileDataPoint.findMany.mockResolvedValue([
      { field: 'rate.post', value: 15000, unit: 'RUB', confidence: 0.9, capturedAt: new Date('2026-05-02T00:00:00Z') },
      { field: 'reach.story', value: 12000, unit: null, confidence: 0.85, capturedAt: new Date('2026-05-02T00:00:00Z') },
    ]);

    const result = await handleProfileExtract({ conversationId: 'conv1' });

    // Profile created/looked up by channelId.
    expect(mocks.prisma.bloggerProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { channelId: 'ch1' } }),
    );
    // Both data points persisted, attributed to the latest inbound message.
    expect(mocks.prisma.profileDataPoint.create).toHaveBeenCalledTimes(2);
    const createdFields = mocks.prisma.profileDataPoint.create.mock.calls.map(
      (c) => (c[0] as { data: { field: string; sourceMessageId: string } }).data,
    );
    expect(createdFields.map((d) => d.field).sort()).toEqual(['rate.post', 'reach.story']);
    expect(createdFields.every((d) => d.sourceMessageId === 'm2')).toBe(true);
    // Roll-up wrote the standardized fields onto the profile.
    expect(mocks.prisma.bloggerProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'prof1' },
        data: expect.objectContaining({
          reach: 12000,
          rateCards: [{ format: 'post', price: 15000, currency: 'RUB' }],
        }),
      }),
    );
    expect(result).toMatchObject({ ok: true, profileId: 'prof1', dataPointsCreated: 2 });
  });

  it('skips when the contact has no channel', async () => {
    mocks.prisma.conversation.findUnique.mockResolvedValue({
      id: 'conv1',
      contact: { id: 'c1', channelId: null, channel: null },
    });
    const result = await handleProfileExtract({ conversationId: 'conv1' });
    expect(result).toMatchObject({ skipped: 'no_channel' });
    expect(mocks.prisma.bloggerProfile.upsert).not.toHaveBeenCalled();
  });
});
