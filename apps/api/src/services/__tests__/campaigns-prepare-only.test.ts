import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * campaignsService.addContacts `{ prepareOnly: true }`
 * (fix-guided-discovery-evidence-loop, D7). The launch-into-work bridge MUST
 * NOT auto-send: prepareOnly forces the conversation into `manual` mode even
 * when the campaign's `defaultMode` is `semi_auto`/`auto`, so the enqueued
 * opener lands as a PENDING suggestion that `tryAutoApprove` refuses. Default
 * (no opts) preserves today's `defaultMode` behavior.
 */

const mocks = vi.hoisted(() => {
  const conversationUpsert = vi.fn(async (_args: unknown) => ({ id: 'conv_1' }));
  const conversationUpdate = vi.fn(async (_args: unknown) => ({ id: 'conv_existing' }));
  const agentRunAdd = vi.fn(async () => ({}));
  const prisma = {
    campaign: { findUnique: vi.fn(), update: vi.fn(async () => ({})) },
    contact: { findMany: vi.fn(), update: vi.fn(async () => ({})) },
    tgAccount: { findMany: vi.fn() },
    conversation: { upsert: conversationUpsert, update: conversationUpdate },
    message: { count: vi.fn(async () => 0) },
    suggestion: { count: vi.fn(async () => 0) },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => fn(prisma));
  return { prisma, conversationUpsert, conversationUpdate, agentRunAdd };
});

vi.mock('@nosquare/db', () => ({ getPrisma: () => mocks.prisma }));
vi.mock('../../queues.js', () => ({ getQueues: () => ({ agentRun: { add: mocks.agentRunAdd } }) }));
vi.mock('../../feature-flags.js', () => ({ getFeatureFlags: () => ({ get: () => true }) }));
vi.mock('../campaign-types.js', () => ({ campaignTypesService: { validateGoal: (_t: unknown, g: unknown) => g } }));

import { campaignsService } from '../campaigns.js';

function setup(defaultMode: string) {
  mocks.prisma.campaign.findUnique.mockResolvedValue({
    id: 'camp_1',
    defaultMode,
    targetFilter: { tags: [] },
    outreachAccountPool: ['acct_1'],
  });
  mocks.prisma.contact.findMany.mockImplementation(async ({ where }: { where: { reachability?: string } }) => {
    if (where.reachability === 'reachable_tg') {
      return [{ id: 'contact_1', conversations: [] }];
    }
    return [{ id: 'contact_1', tags: [], reachability: 'reachable_tg' }];
  });
  mocks.prisma.tgAccount.findMany.mockResolvedValue([{ id: 'acct_1' }]);
}

function setupExistingConversation(defaultMode: string) {
  mocks.prisma.campaign.findUnique.mockResolvedValue({
    id: 'camp_1',
    defaultMode,
    targetFilter: { tags: [] },
    outreachAccountPool: ['acct_1'],
  });
  mocks.prisma.contact.findMany.mockImplementation(async ({ where }: { where: { reachability?: string } }) => {
    if (where.reachability === 'reachable_tg') {
      // Contact already has a campaign conversation (existing-row launch path).
      return [{ id: 'contact_1', conversations: [{ id: 'conv_existing' }] }];
    }
    return [{ id: 'contact_1', tags: [], reachability: 'reachable_tg' }];
  });
  mocks.prisma.tgAccount.findMany.mockResolvedValue([{ id: 'acct_1' }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.message.count.mockResolvedValue(0);
  mocks.prisma.suggestion.count.mockResolvedValue(0);
});

describe('addContacts prepareOnly', () => {
  it('forces manual mode even when defaultMode is semi_auto', async () => {
    setup('semi_auto');
    await campaignsService.addContacts('camp_1', ['contact_1'], { prepareOnly: true });
    const arg = mocks.conversationUpsert.mock.calls[0]![0] as { create: { mode: string }; update: { mode: string } };
    expect(arg.create.mode).toBe('manual');
    expect(arg.update.mode).toBe('manual');
    // opener still enqueued as a (pending) suggestion job.
    expect(mocks.agentRunAdd).toHaveBeenCalled();
  });

  it('forces manual mode even when defaultMode is auto', async () => {
    setup('auto');
    await campaignsService.addContacts('camp_1', ['contact_1'], { prepareOnly: true });
    const arg = mocks.conversationUpsert.mock.calls[0]![0] as { create: { mode: string } };
    expect(arg.create.mode).toBe('manual');
  });

  it('default (no opts) preserves the campaign defaultMode', async () => {
    setup('semi_auto');
    await campaignsService.addContacts('camp_1', ['contact_1']);
    const arg = mocks.conversationUpsert.mock.calls[0]![0] as { create: { mode: string } };
    expect(arg.create.mode).toBe('semi_auto');
  });

  it('downgrades an EXISTING semi_auto conversation to manual under prepareOnly (BUG #2)', async () => {
    setupExistingConversation('semi_auto');
    await campaignsService.addContacts('camp_1', ['contact_1'], { prepareOnly: true });
    // No upsert (existing row reused), but the existing conversation is forced
    // to manual so tryAutoApprove cannot auto-send the enqueued opener.
    expect(mocks.conversationUpsert).not.toHaveBeenCalled();
    expect(mocks.conversationUpdate).toHaveBeenCalledWith({
      where: { id: 'conv_existing' },
      data: { mode: 'manual' },
    });
    // opener still enqueued (as a pending suggestion job).
    expect(mocks.agentRunAdd).toHaveBeenCalled();
  });

  it('does NOT touch an existing conversation mode without prepareOnly', async () => {
    setupExistingConversation('semi_auto');
    await campaignsService.addContacts('camp_1', ['contact_1']);
    expect(mocks.conversationUpdate).not.toHaveBeenCalled();
  });
});
