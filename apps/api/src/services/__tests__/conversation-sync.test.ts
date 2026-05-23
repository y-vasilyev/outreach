// Env stubbing runs from vitest's setupFiles in
// `apps/api/vitest.config.ts` — the env vars are present before any
// import here, so importing the service won't crash on env validation.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------- Mocks for cross-package deps ------------------------------------
//
// `syncOne` reaches into Prisma, the queue map, the TgClient handle, and the
// realtime emitter. We swap each of those for a controllable stub so the test
// can drive specific scenarios — e.g. dedupe-against-existing, FloodWait
// bailout, bounded suggestion regen.

interface PrismaMock {
  conversation: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  message: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
}

const prismaMock: PrismaMock = {
  conversation: {
    findUnique: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
  },
  message: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn().mockResolvedValue({}),
  },
  $transaction: vi.fn(),
};
prismaMock.$transaction.mockImplementation(
  async (fn: (tx: PrismaMock) => Promise<unknown>): Promise<unknown> => fn(prismaMock),
);

vi.mock('@nosquare/db', () => ({
  getPrisma: () => prismaMock,
}));

const queuesMock = {
  agentRun: { add: vi.fn().mockResolvedValue({}) },
};

vi.mock('../../queues.js', () => ({
  getQueues: () => queuesMock,
}));

const handleMock = {
  isAuthorized: true,
  fetchHistorySince: vi.fn(),
};

vi.mock('../tg-accounts.js', () => ({
  getTgClient: () => ({ for: async () => handleMock }),
}));

vi.mock('../../realtime/io.js', () => ({
  emitToRoom: vi.fn(),
}));

// Imported AFTER mocks so the module wiring lands on the stubs.
import { syncOne, syncOneWithBudget, _resetSyncCacheForTests } from '../conversation-sync.js';

beforeEach(() => {
  vi.clearAllMocks();
  _resetSyncCacheForTests();
  prismaMock.conversation.findUnique.mockReset();
  prismaMock.message.findFirst.mockReset();
  prismaMock.message.findMany.mockReset();
  handleMock.fetchHistorySince.mockReset();

  // Sensible defaults — individual tests override.
  prismaMock.conversation.findUnique.mockResolvedValue({
    id: 'conv1',
    tgAccountId: 'tg1',
    contactId: 'c1',
    contact: { id: 'c1', tgUserId: '999', tgUsername: null, value: '999', type: 'tg_username' },
  });
  prismaMock.message.findFirst.mockResolvedValue(null);
  prismaMock.message.findMany.mockResolvedValue([]);
});

describe('conversation-sync.syncOne', () => {
  it('persists a missed inbound and triggers exactly one agent-run', async () => {
    handleMock.fetchHistorySince.mockResolvedValueOnce([
      {
        tgAccountId: 'tg1',
        peerTgUserId: '999',
        fromTgUserId: '999',
        text: 'привет',
        tgMsgId: '101',
        sentAt: '2026-05-08T10:00:00.000Z',
        out: false,
      },
    ]);

    const result = await syncOne('conv1');
    expect(result.persisted).toBe(1);
    expect(result.triggeredOnInbound).toBe(true);
    expect(prismaMock.message.create).toHaveBeenCalledTimes(1);
    expect(queuesMock.agentRun.add).toHaveBeenCalledTimes(1);
    expect(queuesMock.agentRun.add.mock.calls[0]?.[0]).toBe('on_inbound');
  });

  it('dedupes against already-persisted tgMsgId', async () => {
    // History returns two inbound messages, but tgMsgId 101 is already in DB.
    prismaMock.message.findMany.mockResolvedValueOnce([{ tgMsgId: '101' }]);
    handleMock.fetchHistorySince.mockResolvedValueOnce([
      {
        tgAccountId: 'tg1',
        peerTgUserId: '999',
        fromTgUserId: '999',
        text: 'first',
        tgMsgId: '101',
        sentAt: '2026-05-08T09:00:00.000Z',
        out: false,
      },
      {
        tgAccountId: 'tg1',
        peerTgUserId: '999',
        fromTgUserId: '999',
        text: 'second',
        tgMsgId: '102',
        sentAt: '2026-05-08T10:00:00.000Z',
        out: false,
      },
    ]);

    const result = await syncOne('conv1');
    // Only the new one is persisted — overlap is dropped.
    expect(result.persisted).toBe(1);
    expect(prismaMock.message.create).toHaveBeenCalledTimes(1);
  });

  it('long outage produces ONE agent-run regardless of backfill count', async () => {
    handleMock.fetchHistorySince.mockResolvedValueOnce(
      Array.from({ length: 5 }, (_, i) => ({
        tgAccountId: 'tg1',
        peerTgUserId: '999',
        fromTgUserId: '999',
        text: `msg ${i}`,
        tgMsgId: String(200 + i),
        sentAt: `2026-05-08T${String(10 + i).padStart(2, '0')}:00:00.000Z`,
        out: false,
      })),
    );

    const result = await syncOne('conv1');
    expect(result.persisted).toBe(5);
    // All five are persisted, but only ONE on_inbound is enqueued.
    expect(prismaMock.message.create).toHaveBeenCalledTimes(5);
    expect(queuesMock.agentRun.add).toHaveBeenCalledTimes(1);
  });

  it('skips outbound history rows (we do not overwrite our own bookkeeping)', async () => {
    handleMock.fetchHistorySince.mockResolvedValueOnce([
      {
        tgAccountId: 'tg1',
        peerTgUserId: '999',
        fromTgUserId: 'me',
        text: 'our reply',
        tgMsgId: '300',
        sentAt: '2026-05-08T10:00:00.000Z',
        out: true,
      },
    ]);

    const result = await syncOne('conv1');
    expect(result.persisted).toBe(0);
    expect(prismaMock.message.create).not.toHaveBeenCalled();
    expect(queuesMock.agentRun.add).not.toHaveBeenCalled();
  });

  it('handles TG transport failure gracefully (no throw, no persist)', async () => {
    handleMock.fetchHistorySince.mockRejectedValueOnce(new Error('FLOOD_WAIT_30'));

    const result = await syncOne('conv1');
    expect(result.skipped).toBe('tg_error');
    expect(prismaMock.message.create).not.toHaveBeenCalled();
  });

  it('serves second open within 30s from cache without hitting TG', async () => {
    handleMock.fetchHistorySince.mockResolvedValueOnce([]);
    await syncOne('conv-cache');
    expect(handleMock.fetchHistorySince).toHaveBeenCalledTimes(1);

    const second = await syncOne('conv-cache');
    expect(second.cached).toBe(true);
    expect(handleMock.fetchHistorySince).toHaveBeenCalledTimes(1); // unchanged
  });
});

describe('conversation-sync.syncOneWithBudget', () => {
  it('returns done=true when sync completes within budget', async () => {
    handleMock.fetchHistorySince.mockResolvedValueOnce([]);
    const out = await syncOneWithBudget('conv1', 1500);
    expect(out.done).toBe(true);
    expect(out.result?.persisted).toBe(0);
  });

  it('returns done=false when sync exceeds budget', async () => {
    handleMock.fetchHistorySince.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve([]), 200)),
    );
    const out = await syncOneWithBudget('conv-slow', 50);
    expect(out.done).toBe(false);
  });
});
