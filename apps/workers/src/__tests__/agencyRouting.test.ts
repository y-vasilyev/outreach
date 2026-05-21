import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flags as readonlyFlags } from '@nosquare/shared';

// `flags` is declared `as const` (readonly at the type level) but is a plain
// runtime object — toggle a mutable view in tests, restored in afterEach.
const flags = readonlyFlags as unknown as {
  ENABLE_AGENCY_SOURCING: boolean;
  ENABLE_CAMPAIGN_TYPES: boolean;
};

/**
 * B2 worker wiring (agency-sourcing-matching): on_inbound resolves the
 * reply-role agent via the campaign type's agentSet for agency_sourcing
 * conversations (behind ENABLE_AGENCY_SOURCING), and fans out a
 * profile-extract job. CustDev / flag-off stays on the literal agent names
 * and never enqueues profile extraction.
 */

const mocks = vi.hoisted(() => {
  const prisma = {
    conversation: { findUnique: vi.fn(), update: vi.fn() },
    message: { findMany: vi.fn(), create: vi.fn() },
    suggestion: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  const runAgentSafe = vi.fn();
  const publishRealtime = vi.fn();
  const tryAutoApprove = vi.fn();
  const queueAdd = vi.fn();
  return { prisma, runAgentSafe, publishRealtime, tryAutoApprove, queueAdd };
});

vi.mock('@nosquare/db', () => ({ getPrisma: () => mocks.prisma }));
vi.mock('bullmq', () => ({
  Worker: class {},
  Queue: class {
    add = mocks.queueAdd;
  },
}));
vi.mock('../redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../services/run-agent-safe.js', () => ({ runAgentSafe: mocks.runAgentSafe }));
vi.mock('../services/realtime-emit.js', () => ({ publishRealtime: mocks.publishRealtime }));
vi.mock('../services/auto-approve.js', () => ({ tryAutoApprove: mocks.tryAutoApprove }));
vi.mock('../services/agent-input.js', () => ({ buildContactPromptInput: () => ({}) }));
vi.mock('../services/contact-profile.js', () => ({ ensureContactTgProfile: vi.fn() }));

import { handleOnInbound } from '../queues/agent-run.js';

const SAMPLE_AJTBD = {
  job: 'agency sourcing',
  when: 'when channel runs ads',
  forces: { push: [], pull: [], anxieties: [], habits: [] },
  desired_outcome: 'collected commercial data',
  non_goals: [],
};

const AGENCY_AGENT_SET = {
  opening_composer: { agentName: 'agency_opening_composer', overrides: {} },
  reply_composer: { agentName: 'reply_composer', overrides: {} },
  data_collection_planner: { agentName: 'data_collection_planner', overrides: {} },
};

function setupConversation(opts: { typeKey?: string; agentSet?: unknown }): void {
  mocks.prisma.conversation.findUnique.mockResolvedValue({
    id: 'conv1',
    mode: 'assisted',
    summary: '',
    qualityDecision: null,
    contact: { id: 'c1', value: '999', type: 'tg_username', channel: { analysis: {} } },
    campaign: {
      id: 'cmp1',
      ajtbd: SAMPLE_AJTBD,
      goalText: 'g',
      valueProp: 'v',
      ...(opts.typeKey
        ? { type: { key: opts.typeKey, safetyProfile: {}, autonomyPolicy: {}, agentSet: opts.agentSet ?? {} } }
        : {}),
    },
  });
  mocks.prisma.message.findMany.mockResolvedValue([
    {
      id: 'm1',
      conversationId: 'conv1',
      direction: 'in_',
      sender: 'contact',
      text: 'пост 15000, охваты сторис 12к',
      createdAt: new Date('2026-05-08T10:00:00.000Z'),
    },
  ]);
  mocks.prisma.suggestion.create.mockResolvedValue({
    id: 'sug1',
    agentName: 'reply_composer',
    text: 't',
    rationale: 'r',
    score: 0.9,
    status: 'pending',
    createdAt: new Date(),
  });
}

function setAgentResponses(): void {
  mocks.runAgentSafe.mockImplementation(async (name: string) => {
    switch (name) {
      case 'intent_classifier':
        return { intent: 'discusses_price', confidence: 0.9 };
      case 'handoff_decider':
        return { action: 'ai_continue', reason: 'ok', urgency: 'normal' };
      case 'reply_composer':
        return { variants: [{ text: 't', intent_target: 'qualify', rationale: 'r' }] };
      case 'safety_filter':
        return { allow: true, reasons: [], risk_score: 0.1 };
      default:
        return null;
    }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.conversation.update.mockResolvedValue({});
  mocks.prisma.$transaction.mockImplementation(
    async (fn: (tx: typeof mocks.prisma) => Promise<unknown>) => fn(mocks.prisma),
  );
  mocks.publishRealtime.mockResolvedValue(undefined);
  mocks.tryAutoApprove.mockResolvedValue(false);
  mocks.queueAdd.mockResolvedValue({});
  setAgentResponses();
});

afterEach(() => {
  flags.ENABLE_AGENCY_SOURCING = false;
  flags.ENABLE_CAMPAIGN_TYPES = false;
});

describe('handleOnInbound — agency routing (B2)', () => {
  it('enqueues profile-extract for an agency_sourcing conversation when the flag is on', async () => {
    flags.ENABLE_AGENCY_SOURCING = true;
    setupConversation({ typeKey: 'agency_sourcing', agentSet: AGENCY_AGENT_SET });

    await handleOnInbound({ conversationId: 'conv1' });

    expect(mocks.queueAdd).toHaveBeenCalledWith(
      'extract',
      expect.objectContaining({ conversationId: 'conv1', sourceMessageId: 'm1' }),
    );
  });

  it('resolves the reply role from the agency agentSet (still reply_composer here)', async () => {
    flags.ENABLE_AGENCY_SOURCING = true;
    setupConversation({ typeKey: 'agency_sourcing', agentSet: AGENCY_AGENT_SET });

    await handleOnInbound({ conversationId: 'conv1' });

    const replyCall = mocks.runAgentSafe.mock.calls.find((c) => c[0] === 'reply_composer');
    expect(replyCall).toBeDefined();
  });

  it('does NOT enqueue profile-extract for CustDev (flag on, custdev type)', async () => {
    flags.ENABLE_AGENCY_SOURCING = true;
    setupConversation({ typeKey: 'custdev', agentSet: {} });

    await handleOnInbound({ conversationId: 'conv1' });

    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it('does NOT enqueue profile-extract when the flag is off (even for agency type)', async () => {
    flags.ENABLE_AGENCY_SOURCING = false;
    setupConversation({ typeKey: 'agency_sourcing', agentSet: AGENCY_AGENT_SET });

    await handleOnInbound({ conversationId: 'conv1' });

    expect(mocks.queueAdd).not.toHaveBeenCalled();
    // Reply path stays on the literal reply_composer.
    const replyCall = mocks.runAgentSafe.mock.calls.find((c) => c[0] === 'reply_composer');
    expect(replyCall).toBeDefined();
  });
});
