import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mocks so vi.mock factories can reference them safely (vitest
// hoists `vi.mock` above all imports — closing over real fn instances
// requires `vi.hoisted`).
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
  return { prisma, runAgentSafe, publishRealtime, tryAutoApprove };
});

vi.mock('@nosquare/db', () => ({ getPrisma: () => mocks.prisma }));
vi.mock('bullmq', () => ({ Worker: class {}, Queue: class {} }));
vi.mock('../redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../services/run-agent-safe.js', () => ({
  runAgentSafe: mocks.runAgentSafe,
}));
vi.mock('../services/realtime-emit.js', () => ({
  publishRealtime: mocks.publishRealtime,
}));
vi.mock('../services/auto-approve.js', () => ({
  tryAutoApprove: mocks.tryAutoApprove,
}));
vi.mock('../services/agent-input.js', () => ({
  buildContactPromptInput: () => ({}),
}));
vi.mock('../services/contact-profile.js', () => ({
  ensureContactTgProfile: vi.fn(),
}));

import { handleOnInbound } from '../queues/agent-run.js';

const SAMPLE_AJTBD = {
  job: 'CustDev interview',
  when: 'when channel gets ad inquiries',
  forces: { push: [], pull: [], anxieties: [], habits: [] },
  desired_outcome: 'agreed interview slot',
  non_goals: ['ad placement', 'partnership'],
};

interface AgentResponses {
  intent_classifier?: unknown;
  handoff_decider?: unknown;
  reply_composer?: unknown;
  safety_filter?: unknown;
  goal_fit_evaluator?: unknown;
}

function setAgentResponses(responses: AgentResponses): void {
  mocks.runAgentSafe.mockImplementation(async (name: string) => {
    const r = (responses as Record<string, unknown>)[name];
    return r ?? null;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.conversation.findUnique.mockReset();
  mocks.prisma.conversation.update.mockReset();
  mocks.prisma.message.findMany.mockReset();
  mocks.prisma.message.create.mockReset();
  mocks.prisma.suggestion.create.mockReset();
  mocks.prisma.$transaction.mockReset();
  mocks.runAgentSafe.mockReset();
  mocks.publishRealtime.mockReset();
  mocks.tryAutoApprove.mockReset();

  // Defaults — concrete tests override.
  mocks.prisma.conversation.update.mockResolvedValue({});
  mocks.prisma.message.create.mockResolvedValue({});
  mocks.prisma.$transaction.mockImplementation(
    async (fn: (tx: typeof mocks.prisma) => Promise<unknown>) => fn(mocks.prisma),
  );
  mocks.publishRealtime.mockResolvedValue(undefined);
  mocks.tryAutoApprove.mockResolvedValue(false);
});

function setupBaseConversation(opts: {
  mode: 'auto' | 'semi_auto' | 'assisted' | 'manual';
  qualityDecision?: unknown;
}): void {
  mocks.prisma.conversation.findUnique.mockResolvedValue({
    id: 'conv1',
    mode: opts.mode,
    summary: '',
    qualityDecision: opts.qualityDecision ?? null,
    contact: { id: 'c1', value: '999', type: 'tg_username', channel: { analysis: {} } },
    campaign: {
      id: 'cmp1',
      // After `drop-campaign-ajtbd-column` the worker derives the AJTBD
      // view from `campaign.goal` (via `extractAjtbdView`). For CustDev,
      // the goal IS the AJTBD shape.
      goal: SAMPLE_AJTBD,
      goalText: 'interview goal',
      valueProp: 'interview value',
    },
  });
  // One inbound from the contact — required to enter the gate path.
  mocks.prisma.message.findMany.mockResolvedValue([
    {
      id: 'm1',
      conversationId: 'conv1',
      direction: 'in_',
      sender: 'contact',
      text: 'how much for ad placement?',
      createdAt: new Date('2026-05-08T10:00:00.000Z'),
    },
  ]);
  // Persisted suggestion gets a real id so tryAutoApprove call would
  // include it (lets us verify it does NOT get called).
  mocks.prisma.suggestion.create.mockResolvedValue({
    id: 'sug1',
    conversationId: 'conv1',
    agentName: 'reply_composer',
    text: 'safe-draft',
    rationale: 'r',
    score: 0.95,
    status: 'pending',
    createdAt: new Date(),
  });
}

describe('handleOnInbound — silent fallback contract (auto + handoff_silent)', () => {
  it('flips mode to assisted on severe gate handoff (score ≤ 0.3) — single turn', async () => {
    setupBaseConversation({ mode: 'auto' });
    setAgentResponses({
      intent_classifier: { intent: 'wants_payment_for_ads', confidence: 0.9 },
      handoff_decider: { action: 'ai_continue', reason: 'no hard rule', urgency: 'normal' },
      reply_composer: {
        variants: [{ text: 'safe-draft', intent_target: 'clarify', rationale: 'r' }],
      },
      safety_filter: { allow: true, reasons: [], risk_score: 0.05 },
      goal_fit_evaluator: {
        score: 0.2,
        action: 'handoff_silent',
        reasons: ['contact asks for ad placement (non_goal)'],
      },
    });

    const result = await handleOnInbound({ conversationId: 'conv1' });

    // Mode flip + decision persistence happened in the same transaction.
    expect(mocks.prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'conv1' },
        data: expect.objectContaining({
          mode: 'assisted',
          qualityDecision: expect.objectContaining({
            action: 'handoff_silent',
            score: 0.2,
          }),
        }),
      }),
    );
    expect(result).toMatchObject({ flipped: true, gate: 'handoff_silent' });
  });

  it('does NOT call tryAutoApprove when the gate flips the mode silently', async () => {
    setupBaseConversation({ mode: 'auto' });
    setAgentResponses({
      intent_classifier: { intent: 'wants_payment_for_ads', confidence: 0.9 },
      handoff_decider: { action: 'ai_continue', reason: 'ok', urgency: 'normal' },
      reply_composer: {
        variants: [{ text: 'safe-draft', intent_target: 'clarify', rationale: 'r' }],
      },
      safety_filter: { allow: true, reasons: [], risk_score: 0.05 },
      goal_fit_evaluator: {
        score: 0.15,
        action: 'handoff_silent',
        reasons: ['non_goal'],
      },
    });

    await handleOnInbound({ conversationId: 'conv1' });

    // tryAutoApprove is the ONLY path that creates an out_ Message and
    // queues `tg-send`. If it's never called, no contact-visible
    // outbound is produced.
    expect(mocks.tryAutoApprove).not.toHaveBeenCalled();
  });

  it('does NOT create any out_ Message (no direct outbound write in handleOnInbound)', async () => {
    setupBaseConversation({ mode: 'auto' });
    setAgentResponses({
      intent_classifier: { intent: 'wants_payment_for_ads', confidence: 0.9 },
      handoff_decider: { action: 'ai_continue', reason: 'ok', urgency: 'normal' },
      reply_composer: {
        variants: [{ text: 'safe-draft', intent_target: 'clarify', rationale: 'r' }],
      },
      safety_filter: { allow: true, reasons: [], risk_score: 0.05 },
      goal_fit_evaluator: {
        score: 0.15,
        action: 'handoff_silent',
        reasons: ['non_goal'],
      },
    });

    await handleOnInbound({ conversationId: 'conv1' });

    // Defensive — `handleOnInbound` should never call message.create
    // directly, regardless of mode. That contract is what makes the
    // silent fallback possible.
    expect(mocks.prisma.message.create).not.toHaveBeenCalled();
  });

  it('emits quality.gate and mode.changed events to the conversation room (operator-only by routing)', async () => {
    setupBaseConversation({ mode: 'auto' });
    setAgentResponses({
      intent_classifier: { intent: 'wants_payment_for_ads', confidence: 0.9 },
      handoff_decider: { action: 'ai_continue', reason: 'ok', urgency: 'normal' },
      reply_composer: {
        variants: [{ text: 'safe-draft', intent_target: 'clarify', rationale: 'r' }],
      },
      safety_filter: { allow: true, reasons: [], risk_score: 0.05 },
      goal_fit_evaluator: { score: 0.2, action: 'handoff_silent', reasons: ['x'] },
    });

    await handleOnInbound({ conversationId: 'conv1' });

    const calls = mocks.publishRealtime.mock.calls;
    const types = calls.map((c) => (c[1] as { type: string }).type);

    // The gate decision and mode change are surfaced to the operator.
    expect(types).toContain('quality.gate');
    expect(types).toContain('mode.changed');

    // The CRITICAL invariant: nothing that signals an actual outbound
    // delivery (suggestion.approved, message.new) should fire.
    // suggestion.approved is emitted by tryAutoApprove (which we already
    // proved isn't called); message.new is emitted on inbound persist.
    expect(types).not.toContain('suggestion.approved');
    expect(types).not.toContain('message.new');

    // Every event for this conversation routes to `conversation:conv1`,
    // which is the operator-side room — never a contact-side topic.
    for (const c of calls) {
      const room = c[0] as string;
      expect(room.startsWith('conversation:') || room.startsWith('operator:')).toBe(true);
    }
  });

  it('leaves the best safe suggestion as pending (operator picks it up)', async () => {
    setupBaseConversation({ mode: 'auto' });
    setAgentResponses({
      intent_classifier: { intent: 'wants_payment_for_ads', confidence: 0.9 },
      handoff_decider: { action: 'ai_continue', reason: 'ok', urgency: 'normal' },
      reply_composer: {
        variants: [{ text: 'safe-draft', intent_target: 'clarify', rationale: 'r' }],
      },
      safety_filter: { allow: true, reasons: [], risk_score: 0.05 },
      goal_fit_evaluator: { score: 0.2, action: 'handoff_silent', reasons: ['x'] },
    });

    await handleOnInbound({ conversationId: 'conv1' });

    expect(mocks.prisma.suggestion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          conversationId: 'conv1',
          status: 'pending',
          text: 'safe-draft',
        }),
      }),
    );
  });
});

describe('handleOnInbound — gate hysteresis composition', () => {
  it('does NOT flip on a single soft handoff (score=0.4, prev=continue)', async () => {
    setupBaseConversation({
      mode: 'auto',
      qualityDecision: { action: 'continue', score: 0.85 },
    });
    setAgentResponses({
      intent_classifier: { intent: 'asks_about_product', confidence: 0.7 },
      handoff_decider: { action: 'ai_continue', reason: 'ok', urgency: 'normal' },
      reply_composer: {
        variants: [{ text: 'safe-draft', intent_target: 'clarify', rationale: 'r' }],
      },
      safety_filter: { allow: true, reasons: [], risk_score: 0.05 },
      goal_fit_evaluator: { score: 0.4, action: 'handoff_silent', reasons: ['drift'] },
    });

    await handleOnInbound({ conversationId: 'conv1' });

    // Decision is recorded — but mode stays `auto`. Verify the conversation.update
    // call DID NOT include a mode flip. The data field for the update
    // call must NOT contain `mode: 'assisted'`.
    const updateCalls = mocks.prisma.conversation.update.mock.calls;
    expect(updateCalls.length).toBeGreaterThan(0);
    for (const call of updateCalls) {
      const data = (call[0] as { data: Record<string, unknown> }).data;
      expect(data.mode).toBeUndefined();
    }
  });

  it('flips on the second consecutive handoff_silent (prev=handoff_silent, score=0.5)', async () => {
    setupBaseConversation({
      mode: 'auto',
      qualityDecision: { action: 'handoff_silent', score: 0.45 },
    });
    setAgentResponses({
      intent_classifier: { intent: 'asks_about_product', confidence: 0.7 },
      handoff_decider: { action: 'ai_continue', reason: 'ok', urgency: 'normal' },
      reply_composer: {
        variants: [{ text: 'safe-draft', intent_target: 'clarify', rationale: 'r' }],
      },
      safety_filter: { allow: true, reasons: [], risk_score: 0.05 },
      goal_fit_evaluator: { score: 0.5, action: 'handoff_silent', reasons: ['still off'] },
    });

    await handleOnInbound({ conversationId: 'conv1' });

    expect(mocks.prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ mode: 'assisted' }),
      }),
    );
  });
});

describe('handleOnInbound — auto-approve happy path (sanity check the test harness)', () => {
  it('calls tryAutoApprove with gate decision when gate returns continue with high score', async () => {
    setupBaseConversation({ mode: 'auto' });
    setAgentResponses({
      intent_classifier: { intent: 'interested', confidence: 0.85 },
      handoff_decider: { action: 'ai_continue', reason: 'ok', urgency: 'low' },
      reply_composer: {
        variants: [{ text: 'on-track-draft', intent_target: 'clarify', rationale: 'r' }],
      },
      safety_filter: { allow: true, reasons: [], risk_score: 0.05 },
      goal_fit_evaluator: { score: 0.92, action: 'continue', reasons: ['aligned'] },
    });

    await handleOnInbound({ conversationId: 'conv1' });

    // No flip — gate said continue.
    const updateCalls = mocks.prisma.conversation.update.mock.calls;
    for (const call of updateCalls) {
      const data = (call[0] as { data: Record<string, unknown> }).data;
      expect(data.mode).toBeUndefined();
    }

    // tryAutoApprove WAS invoked — and got the gate decision so it can
    // enforce its composition rule.
    expect(mocks.tryAutoApprove).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv1',
        suggestionId: 'sug1',
        gate: { action: 'continue', score: 0.92 },
      }),
    );
  });
});
