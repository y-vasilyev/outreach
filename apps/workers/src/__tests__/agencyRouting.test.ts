import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B2 worker wiring (agency-sourcing-matching) + harden-agency-sourcing-
 * pipeline: on_inbound resolves the reply-role agent via the campaign
 * type's agentSet for agency_sourcing conversations (gated by the runtime
 * `agency_sourcing` flag), and SYNCHRONOUSLY runs `handleProfileExtract`
 * for the triggering inbound before the planner sees it. CustDev / flag-
 * off stays on the literal agent names and never extracts.
 *
 * `handleProfileExtract` is mocked here so we only assert it's INVOKED
 * with the right arguments — its own behaviour is covered in
 * profileExtract.test.ts.
 */

const mocks = vi.hoisted(() => {
  const prisma = {
    conversation: { findUnique: vi.fn(), update: vi.fn() },
    message: { findMany: vi.fn(), create: vi.fn() },
    suggestion: { create: vi.fn() },
    bloggerProfile: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  };
  const runAgentSafe = vi.fn();
  const publishRealtime = vi.fn();
  const tryAutoApprove = vi.fn();
  const handleProfileExtract = vi.fn();
  // Mutable runtime-flag state driving getFeatureFlags().get(key).
  const flagState: Record<string, boolean> = {};
  return {
    prisma,
    runAgentSafe,
    publishRealtime,
    tryAutoApprove,
    handleProfileExtract,
    flagState,
  };
});

vi.mock('../feature-flags.js', () => ({
  getFeatureFlags: () => ({ get: (k: string) => mocks.flagState[k] ?? false }),
}));
vi.mock('@nosquare/db', () => ({ getPrisma: () => mocks.prisma }));
vi.mock('bullmq', () => ({
  Worker: class {},
}));
vi.mock('../redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../services/run-agent-safe.js', () => ({ runAgentSafe: mocks.runAgentSafe }));
vi.mock('../services/realtime-emit.js', () => ({ publishRealtime: mocks.publishRealtime }));
vi.mock('../services/auto-approve.js', () => ({ tryAutoApprove: mocks.tryAutoApprove }));
vi.mock('../services/agent-input.js', () => ({ buildContactPromptInput: () => ({}) }));
vi.mock('../services/contact-profile.js', () => ({ ensureContactTgProfile: vi.fn() }));
vi.mock('../queues/profile-extract.js', () => ({
  handleProfileExtract: mocks.handleProfileExtract,
}));

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
    contact: { id: 'c1', channelId: 'ch1', value: '999', type: 'tg_username', channel: { analysis: {} } },
    campaign: {
      id: 'cmp1',
      // After `drop-campaign-ajtbd-column` the worker derives the AJTBD
      // view from `campaign.goal` (via `extractAjtbdView`). For CustDev,
      // the goal IS the AJTBD shape.
      goal: SAMPLE_AJTBD,
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
      case 'data_collection_planner':
        return {
          reply: 'Какие у вас охваты на пост и сторис?',
          next_data_point: 'reach',
          goal_satisfied: false,
          rationale: 'спрашиваем reach',
        };
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
  mocks.handleProfileExtract.mockResolvedValue({ ok: true });
  mocks.prisma.bloggerProfile.findUnique.mockResolvedValue(null);
  setAgentResponses();
});

afterEach(() => {
  mocks.flagState.agency_sourcing = false;
  mocks.flagState.campaign_types = false;
});

describe('handleOnInbound — agency routing (B2 + harden)', () => {
  it('runs profile-extract synchronously for an agency_sourcing conversation when the flag is on', async () => {
    // harden-agency-sourcing-pipeline: previously the inbound fanned out a
    // BullMQ job; now it invokes `handleProfileExtract` directly BEFORE
    // the DataCollectionPlanner so the planner sees facts in this inbound.
    mocks.flagState.agency_sourcing = true;
    setupConversation({ typeKey: 'agency_sourcing', agentSet: AGENCY_AGENT_SET });

    await handleOnInbound({ conversationId: 'conv1' });

    expect(mocks.handleProfileExtract).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv1', sourceMessageId: 'm1' }),
    );
    // It ran BEFORE the planner (sync ordering).
    const callOrder = mocks.handleProfileExtract.mock.invocationCallOrder[0] ?? 0;
    const plannerOrder =
      mocks.runAgentSafe.mock.calls
        .map((c, i) =>
          c[0] === 'data_collection_planner'
            ? mocks.runAgentSafe.mock.invocationCallOrder[i] ?? 0
            : 0,
        )
        .find((n) => n > 0) ?? Number.POSITIVE_INFINITY;
    expect(callOrder).toBeLessThan(plannerOrder);
  });

  it('drives the agency reply with data_collection_planner (not reply_composer)', async () => {
    mocks.flagState.agency_sourcing = true;
    setupConversation({ typeKey: 'agency_sourcing', agentSet: AGENCY_AGENT_SET });

    await handleOnInbound({ conversationId: 'conv1' });

    const plannerCall = mocks.runAgentSafe.mock.calls.find(
      (c) => c[0] === 'data_collection_planner',
    );
    expect(plannerCall).toBeDefined();
    // The planner gets the default target set + collected (none → []) here.
    expect(plannerCall?.[1]).toMatchObject({
      target_data_points: expect.arrayContaining(['rate_card', 'reach']),
      collected_data_points: [],
    });
    // Agency path does NOT call reply_composer.
    expect(mocks.runAgentSafe.mock.calls.find((c) => c[0] === 'reply_composer')).toBeUndefined();
    // The planner's reply is turned into a suggestion.
    expect(mocks.prisma.suggestion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ text: 'Какие у вас охваты на пост и сторис?' }),
      }),
    );
  });

  it('marks collected targets from the blogger profile so the planner skips them', async () => {
    mocks.flagState.agency_sourcing = true;
    setupConversation({ typeKey: 'agency_sourcing', agentSet: AGENCY_AGENT_SET });
    // Profile already has a rate-card data point → rate_card is "collected".
    mocks.prisma.bloggerProfile.findUnique.mockResolvedValue({
      dataPoints: [{ field: 'rate.post' }, { field: 'reach.story' }],
    });

    await handleOnInbound({ conversationId: 'conv1' });

    const plannerCall = mocks.runAgentSafe.mock.calls.find(
      (c) => c[0] === 'data_collection_planner',
    );
    expect(plannerCall?.[1]).toMatchObject({
      collected_data_points: expect.arrayContaining(['rate_card', 'reach']),
    });
  });

  it('does NOT run profile-extract for CustDev (flag on, custdev type)', async () => {
    mocks.flagState.agency_sourcing = true;
    setupConversation({ typeKey: 'custdev', agentSet: {} });

    await handleOnInbound({ conversationId: 'conv1' });

    expect(mocks.handleProfileExtract).not.toHaveBeenCalled();
  });

  it('skips the pipeline AND hands off to operator when agency type meets flag-off', async () => {
    // harden-agency-sourcing-pipeline review fix: previously the worker
    // logged a warning and ran the CustDev pipeline anyway — silent
    // degradation. Now the run aborts with `skipped:agency_sourcing_disabled`
    // and the conversation is flipped to `assisted` so the operator sees
    // the inbound and can decide what to do.
    mocks.flagState.agency_sourcing = false;
    setupConversation({ typeKey: 'agency_sourcing', agentSet: AGENCY_AGENT_SET });

    const result = await handleOnInbound({ conversationId: 'conv1' });

    expect(result).toMatchObject({ ok: true, skipped: 'agency_sourcing_disabled' });
    expect(mocks.handleProfileExtract).not.toHaveBeenCalled();
    // No reply pipeline ran — neither CustDev `reply_composer` nor the
    // agency planner.
    expect(mocks.runAgentSafe.mock.calls.find((c) => c[0] === 'reply_composer')).toBeUndefined();
    expect(
      mocks.runAgentSafe.mock.calls.find((c) => c[0] === 'data_collection_planner'),
    ).toBeUndefined();
    // The conversation was flipped to assisted so the operator sees it.
    expect(mocks.prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'conv1' },
        data: expect.objectContaining({ mode: 'assisted' }),
      }),
    );
  });
});
