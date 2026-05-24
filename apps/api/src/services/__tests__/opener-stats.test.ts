import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAppError } from '@nosquare/shared/errors';

/**
 * Opener-stats service (ab-opener-variants change).
 *
 * Aggregates `Message.openerVariant` outbound counts per campaign, plus
 * how many of those outbounds saw at least one inbound reply within
 * `withinHours`. Pure-mock test: we only exercise the math and the
 * 404 path; the underlying SQL behaviour is exercised by integration.
 */

const mocks = vi.hoisted(() => {
  const prisma = {
    campaign: { findUnique: vi.fn() },
    message: { findMany: vi.fn() },
  };
  return { prisma };
});

vi.mock('@nosquare/db', () => ({ getPrisma: () => mocks.prisma }));

import { openerStatsService } from '../opener-stats.js';

const CAMPAIGN_ID = 'cmp_1';
const NOW = new Date('2026-05-24T12:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.campaign.findUnique.mockResolvedValue({ id: CAMPAIGN_ID });
});

describe('openerStatsService.get', () => {
  it('returns 404 when the campaign does not exist', async () => {
    mocks.prisma.campaign.findUnique.mockResolvedValueOnce(null);
    await expect(openerStatsService.get('missing', 48)).rejects.toSatisfy(
      (e: unknown) => isAppError(e) && e.code === 'NOT_FOUND',
    );
  });

  it('returns [] when the campaign has zero opener-tagged messages', async () => {
    mocks.prisma.message.findMany.mockResolvedValueOnce([]);
    const rows = await openerStatsService.get(CAMPAIGN_ID, 48);
    expect(rows).toEqual([]);
    // No inbound query happens when there are no openers.
    expect(mocks.prisma.message.findMany).toHaveBeenCalledTimes(1);
  });

  it('aggregates sent counts and reply counts per variantKey', async () => {
    // 5 'A' opens (1 reply), 3 'B' opens (0 replies).
    const openers = [
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `mA${i}`,
        conversationId: `conv_A_${i}`,
        openerVariant: 'A',
        sentAt: new Date(NOW.getTime() - 1 * 60 * 60 * 1000),
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        id: `mB${i}`,
        conversationId: `conv_B_${i}`,
        openerVariant: 'B',
        sentAt: new Date(NOW.getTime() - 1 * 60 * 60 * 1000),
      })),
    ];
    mocks.prisma.message.findMany.mockResolvedValueOnce(openers);
    // One inbound in window for conv_A_0.
    mocks.prisma.message.findMany.mockResolvedValueOnce([
      {
        conversationId: 'conv_A_0',
        createdAt: new Date(NOW.getTime() - 30 * 60 * 1000),
      },
    ]);

    const rows = await openerStatsService.get(CAMPAIGN_ID, 48);

    expect(rows).toEqual([
      { variantKey: 'A', sent: 5, replied: 1, replyRate: 0.2 },
      { variantKey: 'B', sent: 3, replied: 0, replyRate: 0 },
    ]);
  });

  it('does not count inbounds outside the time window', async () => {
    const openerSentAt = new Date(NOW.getTime() - 100 * 60 * 60 * 1000);
    mocks.prisma.message.findMany.mockResolvedValueOnce([
      {
        id: 'm1',
        conversationId: 'conv_1',
        openerVariant: 'A',
        sentAt: openerSentAt,
      },
    ]);
    // Inbound 72h after opener; withinHours=48 → out of window.
    mocks.prisma.message.findMany.mockResolvedValueOnce([
      {
        conversationId: 'conv_1',
        createdAt: new Date(openerSentAt.getTime() + 72 * 60 * 60 * 1000),
      },
    ]);

    const rows = await openerStatsService.get(CAMPAIGN_ID, 48);
    expect(rows).toEqual([{ variantKey: 'A', sent: 1, replied: 0, replyRate: 0 }]);
  });

  it('counts an inbound exactly at the window edge as a reply (inclusive end)', async () => {
    const openerSentAt = new Date(NOW.getTime() - 49 * 60 * 60 * 1000);
    mocks.prisma.message.findMany.mockResolvedValueOnce([
      {
        id: 'm1',
        conversationId: 'conv_1',
        openerVariant: 'A',
        sentAt: openerSentAt,
      },
    ]);
    // Inbound at sentAt + 48h exactly.
    mocks.prisma.message.findMany.mockResolvedValueOnce([
      {
        conversationId: 'conv_1',
        createdAt: new Date(openerSentAt.getTime() + 48 * 60 * 60 * 1000),
      },
    ]);

    const rows = await openerStatsService.get(CAMPAIGN_ID, 48);
    expect(rows[0]!.replied).toBe(1);
  });

  it('ignores inbounds that arrived BEFORE the opener (no negative-window attribution)', async () => {
    const openerSentAt = new Date(NOW.getTime() - 1 * 60 * 60 * 1000);
    mocks.prisma.message.findMany.mockResolvedValueOnce([
      {
        id: 'm1',
        conversationId: 'conv_1',
        openerVariant: 'A',
        sentAt: openerSentAt,
      },
    ]);
    mocks.prisma.message.findMany.mockResolvedValueOnce([
      {
        conversationId: 'conv_1',
        createdAt: new Date(openerSentAt.getTime() - 60 * 1000),
      },
    ]);

    const rows = await openerStatsService.get(CAMPAIGN_ID, 48);
    expect(rows[0]!.replied).toBe(0);
  });

  it('sorts rows by variantKey ascending', async () => {
    mocks.prisma.message.findMany.mockResolvedValueOnce([
      { id: 'm1', conversationId: 'c1', openerVariant: 'value_prop', sentAt: NOW },
      { id: 'm2', conversationId: 'c2', openerVariant: 'concise', sentAt: NOW },
      { id: 'm3', conversationId: 'c3', openerVariant: 'A', sentAt: NOW },
    ]);
    mocks.prisma.message.findMany.mockResolvedValueOnce([]);

    const rows = await openerStatsService.get(CAMPAIGN_ID, 48);
    expect(rows.map((r) => r.variantKey)).toEqual(['A', 'concise', 'value_prop']);
  });

  it('clamps replyRate to [0, 1]', async () => {
    // Defensive — in production the math can't exceed 1 because we count
    // bool-OR-per-opener, but a future refactor could change it.
    const openers = [
      { id: 'm1', conversationId: 'c1', openerVariant: 'A', sentAt: NOW },
    ];
    mocks.prisma.message.findMany.mockResolvedValueOnce(openers);
    // Two inbounds for the same opener → still counts as one reply (boolean some).
    mocks.prisma.message.findMany.mockResolvedValueOnce([
      { conversationId: 'c1', createdAt: new Date(NOW.getTime() + 60 * 1000) },
      { conversationId: 'c1', createdAt: new Date(NOW.getTime() + 120 * 1000) },
    ]);

    const rows = await openerStatsService.get(CAMPAIGN_ID, 48);
    expect(rows[0]!.replied).toBe(1);
    expect(rows[0]!.replyRate).toBe(1);
  });

  it('handles multiple openers across a mix of variants and partial replies', async () => {
    // 'A': 2 sent, 2 replied (100%)
    // 'B': 4 sent, 1 replied (25%)
    // 'C': 1 sent, 0 replied (0%)
    const openers = [
      { id: 'mA1', conversationId: 'cA1', openerVariant: 'A', sentAt: NOW },
      { id: 'mA2', conversationId: 'cA2', openerVariant: 'A', sentAt: NOW },
      { id: 'mB1', conversationId: 'cB1', openerVariant: 'B', sentAt: NOW },
      { id: 'mB2', conversationId: 'cB2', openerVariant: 'B', sentAt: NOW },
      { id: 'mB3', conversationId: 'cB3', openerVariant: 'B', sentAt: NOW },
      { id: 'mB4', conversationId: 'cB4', openerVariant: 'B', sentAt: NOW },
      { id: 'mC1', conversationId: 'cC1', openerVariant: 'C', sentAt: NOW },
    ];
    mocks.prisma.message.findMany.mockResolvedValueOnce(openers);
    mocks.prisma.message.findMany.mockResolvedValueOnce([
      { conversationId: 'cA1', createdAt: new Date(NOW.getTime() + 60 * 1000) },
      { conversationId: 'cA2', createdAt: new Date(NOW.getTime() + 60 * 1000) },
      { conversationId: 'cB1', createdAt: new Date(NOW.getTime() + 60 * 1000) },
    ]);

    const rows = await openerStatsService.get(CAMPAIGN_ID, 48);
    expect(rows).toEqual([
      { variantKey: 'A', sent: 2, replied: 2, replyRate: 1 },
      { variantKey: 'B', sent: 4, replied: 1, replyRate: 0.25 },
      { variantKey: 'C', sent: 1, replied: 0, replyRate: 0 },
    ]);
  });
});
