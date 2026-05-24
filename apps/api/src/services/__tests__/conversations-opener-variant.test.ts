import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Operator-approve / send-from-suggestion paths must carry the
 * `Suggestion.meta.openerVariant` through onto `Message.openerVariant` —
 * mirror of the auto-approve path in `tryAutoApprove`. This test pins
 * the contract for both:
 *   1. `approveSuggestion` (passes openerVariant explicitly to
 *      `sendOperatorMessage` after reading meta).
 *   2. `sendOperatorMessage({ fromSuggestionId })` directly — the
 *      generic route uses this without going through approveSuggestion,
 *      so it must do its own meta lookup.
 *
 * See ab-opener-variants change.
 */

const mocks = vi.hoisted(() => {
  const prisma = {
    conversation: { findUnique: vi.fn() },
    suggestion: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    message: { create: vi.fn() },
  };
  const tgSendAdd = vi.fn(async () => ({}));
  return { prisma, tgSendAdd };
});

vi.mock('@nosquare/db', () => ({
  getPrisma: () => mocks.prisma,
  Prisma: {},
}));
vi.mock('../../queues.js', () => ({
  getQueues: () => ({ tgSend: { add: mocks.tgSendAdd } }),
}));
vi.mock('../../realtime/io.js', () => ({
  emitToRoom: vi.fn(),
}));
vi.mock('../agents.js', () => ({
  getAgentRunner: () => ({
    run: vi.fn(async () => ({ allow: true, reasons: [], risk_score: 0 })),
  }),
}));

import { conversationsService } from '../conversations.js';

beforeEach(() => {
  vi.clearAllMocks();
  // The conversation mock covers BOTH paths:
  //   - `assertOutboundSafe` (approveSuggestion's pre-flight) includes
  //     contact + channel + campaign.
  //   - `sendOperatorMessage`'s bypassSafety path only needs the bare row.
  // The richer shape works in both cases because Prisma `include` is a
  // hint — our mock just returns the same object.
  mocks.prisma.conversation.findUnique.mockResolvedValue({
    id: 'conv1',
    tgAccountId: 'tg1',
    contactId: 'cont1',
    campaignId: null,
    meta: {},
    contact: { id: 'cont1', value: '@x', roleGuess: 'owner', channel: null },
    campaign: null,
  });
  mocks.prisma.message.create.mockResolvedValue({ id: 'msg1' });
  mocks.prisma.suggestion.update.mockResolvedValue({});
  mocks.prisma.suggestion.updateMany.mockResolvedValue({ count: 1 });
});

describe('approveSuggestion → Message.openerVariant pass-through', () => {
  function setupSuggestion(over: {
    agentName: string;
    meta: Record<string, unknown>;
  }) {
    // `approveSuggestion` uses `findUnique` with the conversation include;
    // the subsequent `sendOperatorMessage` call uses `findFirst` (scoped
    // by conversationId) for the security guard. Both must be mocked.
    mocks.prisma.suggestion.findUnique.mockResolvedValue({
      id: 'sug1',
      conversationId: 'conv1',
      text: 'hello',
      conversation: { meta: {} },
      ...over,
    });
    mocks.prisma.suggestion.findFirst.mockResolvedValue(over);
  }

  it('writes Message.openerVariant when the suggestion is opening_composer', async () => {
    setupSuggestion({
      agentName: 'opening_composer',
      meta: { openerVariant: 'B' },
    });
    await conversationsService.approveSuggestion('sug1', 'op1');
    expect(mocks.prisma.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ openerVariant: 'B', suggestionId: 'sug1' }),
    });
  });

  it('writes Message.openerVariant for agency_opening_composer', async () => {
    setupSuggestion({
      agentName: 'agency_opening_composer',
      meta: { openerVariant: 'with_brand' },
    });
    await conversationsService.approveSuggestion('sug1', 'op1');
    expect(mocks.prisma.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ openerVariant: 'with_brand' }),
    });
  });

  it('does NOT set openerVariant for non-opener suggestions (reply_composer)', async () => {
    setupSuggestion({
      agentName: 'reply_composer',
      meta: { openerVariant: 'A' }, // defensive: ignored by extractOpenerVariant
    });
    await conversationsService.approveSuggestion('sug1', 'op1');
    const arg = mocks.prisma.message.create.mock.calls[0]![0];
    expect(arg.data.openerVariant).toBeUndefined();
  });
});

describe('sendOperatorMessage({ fromSuggestionId }) → Message.openerVariant pass-through', () => {
  it('looks up Suggestion.meta scoped to the conversation when called directly', async () => {
    // Generic route: POST /conversations/:id/messages with fromSuggestionId,
    // bypasses approveSuggestion entirely. Must still resolve openerVariant.
    mocks.prisma.suggestion.findFirst.mockResolvedValue({
      agentName: 'opening_composer',
      meta: { openerVariant: 'value_prop' },
    });
    await conversationsService.sendOperatorMessage({
      conversationId: 'conv1',
      text: 'hi',
      fromSuggestionId: 'sug1',
      operatorId: 'op1',
      bypassSafety: true,
    });
    // Critical: the lookup MUST scope by both `id` and `conversationId`,
    // otherwise a fromSuggestionId from another conversation could
    // corrupt attribution.
    expect(mocks.prisma.suggestion.findFirst).toHaveBeenCalledWith({
      where: { id: 'sug1', conversationId: 'conv1' },
      select: { agentName: true, meta: true },
    });
    expect(mocks.prisma.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ openerVariant: 'value_prop' }),
    });
    // Status flip MUST also be scoped.
    expect(mocks.prisma.suggestion.updateMany).toHaveBeenCalledWith({
      where: { id: 'sug1', conversationId: 'conv1' },
      data: { status: 'sent' },
    });
  });

  it('throws 404 when fromSuggestionId belongs to a different conversation', async () => {
    // findFirst returns null when the suggestion exists but is bound to
    // a different conversation.
    mocks.prisma.suggestion.findFirst.mockResolvedValue(null);
    await expect(
      conversationsService.sendOperatorMessage({
        conversationId: 'conv1',
        text: 'hi',
        fromSuggestionId: 'sug_from_other_conv',
        operatorId: 'op1',
        bypassSafety: true,
      }),
    ).rejects.toThrow(/suggestion/i);
    // Critically: we must NOT have created the message or flipped a
    // foreign suggestion's status.
    expect(mocks.prisma.message.create).not.toHaveBeenCalled();
    expect(mocks.prisma.suggestion.updateMany).not.toHaveBeenCalled();
  });

  it('does NOT look up Suggestion when no fromSuggestionId (ad-hoc operator send)', async () => {
    await conversationsService.sendOperatorMessage({
      conversationId: 'conv1',
      text: 'hi',
      operatorId: 'op1',
      bypassSafety: true,
    });
    expect(mocks.prisma.suggestion.findFirst).not.toHaveBeenCalled();
    const arg = mocks.prisma.message.create.mock.calls[0]![0];
    expect(arg.data.openerVariant).toBeUndefined();
  });

  it('does NOT set openerVariant when source suggestion is not an opener', async () => {
    mocks.prisma.suggestion.findFirst.mockResolvedValue({
      agentName: 'reply_composer',
      meta: { openerVariant: 'A' },
    });
    await conversationsService.sendOperatorMessage({
      conversationId: 'conv1',
      text: 'hi',
      fromSuggestionId: 'sug1',
      operatorId: 'op1',
      bypassSafety: true,
    });
    const arg = mocks.prisma.message.create.mock.calls[0]![0];
    expect(arg.data.openerVariant).toBeUndefined();
  });

  it('explicit openerVariant arg wins (lookup still happens for the conv-scope check)', async () => {
    // Caller (approveSuggestion) has already loaded the meta and passes
    // the resolved key explicitly. We still need the findFirst to verify
    // the suggestion belongs to this conversation (security guard); but
    // its meta is ignored in favor of the explicit value.
    mocks.prisma.suggestion.findFirst.mockResolvedValue({
      agentName: 'opening_composer',
      meta: { openerVariant: 'A' },
    });
    await conversationsService.sendOperatorMessage({
      conversationId: 'conv1',
      text: 'hi',
      fromSuggestionId: 'sug1',
      operatorId: 'op1',
      bypassSafety: true,
      openerVariant: 'C',
    });
    expect(mocks.prisma.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ openerVariant: 'C' }),
    });
  });
});
