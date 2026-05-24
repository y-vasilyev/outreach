import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `conversationsService.list` is the data source for the inbox. The
 * service must translate `ConversationFiltersZ` into the right Prisma
 * `where` clause, in particular:
 *   - `q` becomes an `OR` across contact.value / channel.handle /
 *     channel.title with case-insensitive contains;
 *   - other filters remain simple equality;
 *   - all filters are conjunctive (combined into one `where`);
 *   - falsy values are dropped (no `campaignId: undefined`, etc.).
 * inbox-campaign-filter change.
 */

const mocks = vi.hoisted(() => {
  const prisma = {
    conversation: { findMany: vi.fn() },
    message: { findMany: vi.fn() },
    suggestion: { groupBy: vi.fn() },
  };
  return { prisma };
});

vi.mock('@nosquare/db', () => ({
  getPrisma: () => mocks.prisma,
  Prisma: {},
}));
vi.mock('../../queues.js', () => ({ getQueues: () => ({}) }));
vi.mock('../../realtime/io.js', () => ({ emitToRoom: vi.fn() }));
vi.mock('../agents.js', () => ({ getAgentRunner: () => ({ run: vi.fn() }) }));

import { conversationsService } from '../conversations.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.conversation.findMany.mockResolvedValue([]);
  mocks.prisma.message.findMany.mockResolvedValue([]);
  mocks.prisma.suggestion.groupBy.mockResolvedValue([]);
});

function getWhere(): Record<string, unknown> {
  const call = mocks.prisma.conversation.findMany.mock.calls[0]?.[0];
  return (call?.where ?? {}) as Record<string, unknown>;
}

describe('conversationsService.list — filter composition', () => {
  it('no filters → empty where clause', async () => {
    await conversationsService.list({});
    expect(getWhere()).toEqual({});
  });

  it('campaignId narrows the query', async () => {
    await conversationsService.list({ campaignId: 'camp-1' });
    expect(getWhere()).toEqual({ campaignId: 'camp-1' });
  });

  it('status and mode combine conjunctively', async () => {
    await conversationsService.list({ status: 'active', mode: 'manual' });
    expect(getWhere()).toEqual({ status: 'active', mode: 'manual' });
  });

  it('assignedOperatorId is honoured (deep-link path)', async () => {
    await conversationsService.list({ assignedOperatorId: 'op-7' });
    expect(getWhere()).toEqual({ assignedOperatorId: 'op-7' });
  });

  it('q produces an OR across contact value / handle / title with insensitive contains', async () => {
    await conversationsService.list({ q: 'acme' });
    const where = getWhere();
    expect(where).toEqual({
      OR: [
        { contact: { value: { contains: 'acme', mode: 'insensitive' } } },
        { contact: { channel: { handle: { contains: 'acme', mode: 'insensitive' } } } },
        { contact: { channel: { title: { contains: 'acme', mode: 'insensitive' } } } },
      ],
    });
  });

  it('campaignId + q combine into a single conjunctive where', async () => {
    await conversationsService.list({ campaignId: 'camp-1', q: 'acme' });
    const where = getWhere();
    expect(where).toMatchObject({ campaignId: 'camp-1' });
    expect(Array.isArray(where.OR)).toBe(true);
    expect((where.OR as unknown[]).length).toBe(3);
  });

  it('unknown campaignId still produces the same scoped query (DB returns empty)', async () => {
    await conversationsService.list({ campaignId: 'does-not-exist' });
    expect(getWhere()).toEqual({ campaignId: 'does-not-exist' });
    // No filter dropped, no error thrown — service just trusts the DB
    // to return [], matching spec scenario "Unknown campaignId returns
    // an empty list, not an error".
  });

  it('empty/falsy filter values are not emitted to the where clause', async () => {
    await conversationsService.list({
      // The schema would normally normalise these to undefined, but
      // double-belt: the service must also not pass through falsies.
      campaignId: undefined,
      status: undefined,
      mode: undefined,
      q: undefined,
    });
    expect(getWhere()).toEqual({});
  });
});
