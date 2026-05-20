// Env stubbing runs from vitest's setupFiles in apps/api/vitest.config.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BUILDER_REQUIRED_ROLES } from '@nosquare/agents';

// ---------- Mocks for cross-package deps ------------------------------------
//
// The builder service reaches into Prisma (endpoints, agent_config,
// campaign_type, agent_config_history) and the AgentRunner (meta-agent draft
// + per-agent dry-runs). We stub each so we can assert: (a) no live
// agent_config rows are created before save, (b) save creates v1 config +
// history + the campaign_type, (c) a tier with no endpoint is reported.

interface PrismaMock {
  endpoint: { findMany: ReturnType<typeof vi.fn> };
  agentConfig: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  agentConfigHistory: { create: ReturnType<typeof vi.fn> };
  campaignType: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
}

const prismaMock: PrismaMock = {
  endpoint: { findMany: vi.fn() },
  agentConfig: { findUnique: vi.fn(), create: vi.fn() },
  agentConfigHistory: { create: vi.fn() },
  campaignType: { findUnique: vi.fn(), create: vi.fn() },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
  $transaction: vi.fn(),
};
prismaMock.$transaction.mockImplementation(
  async (fn: (tx: PrismaMock) => Promise<unknown>): Promise<unknown> => fn(prismaMock),
);

vi.mock('@nosquare/db', () => ({
  getPrisma: () => prismaMock,
}));

// AgentRunner stub: dryRunConfig is used for the meta-agent draft AND for
// each per-agent fixture run. We branch on the agent name.
const dryRunConfig = vi.fn();
vi.mock('../agents.js', () => ({
  getAgentRunner: () => ({ dryRunConfig }),
}));

// Imported AFTER mocks so module wiring lands on the stubs.
import { campaignTypeBuilderService } from '../campaign-type-builder.js';

function metaDraftOutput() {
  return {
    key: 'podcast_guesting',
    name: 'Гостевание',
    description: 'desc',
    goalSchema: { type: 'object', required: ['target_shows'] },
    safetyProfile: {
      forbidden_topics: [],
      allowed_topics: ['подкаст'],
      allow_links: false,
      max_length: 700,
    },
    autonomyPolicy: {
      defaultMode: 'assisted',
      T_safety: 0.8,
      T_semi_auto_goalfit: 0.6,
      T_auto_goalfit: 0.75,
      forceHandoffIntents: [],
    },
    agents: BUILDER_REQUIRED_ROLES.map((role) => ({
      role,
      description: `for ${role}`,
      systemPrompt: `sys ${role}`,
      userPromptTemplate: `usr ${role}`,
      outputJsonSchema:
        role === 'intent_classifier' || role === 'safety_filter' || role === 'goal_fit_evaluator'
          ? { type: 'object' }
          : null,
    })),
  };
}

const builderAgentRow = {
  id: 'cfg_builder',
  name: 'campaign_type_builder',
  role: 'campaign-type-builder',
  description: '',
  endpointId: 'ep_or',
  fallbackEndpointId: null,
  model: 'anthropic/claude-sonnet-4.6',
  systemPrompt: '',
  userPromptTemplate: '',
  params: {},
  enabled: true,
  version: 1,
  updatedById: null,
  updatedAt: new Date(),
  createdAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(
    async (fn: (tx: PrismaMock) => Promise<unknown>): Promise<unknown> => fn(prismaMock),
  );

  // dryRunConfig: meta-agent draft returns the type design; per-agent runs
  // return a trivial output with token/cost telemetry.
  dryRunConfig.mockImplementation(async (agentName: string) => {
    if (agentName === 'campaign_type_builder') {
      return {
        output: metaDraftOutput(),
        tokensIn: 100,
        tokensOut: 200,
        costUsd: 0.01,
        latencyMs: 50,
      };
    }
    return { output: { ok: true }, tokensIn: 5, tokensOut: 7, costUsd: 0.001, latencyMs: 12 };
  });

  // campaign_type_builder agent_config exists; nothing else does (no dupes).
  prismaMock.agentConfig.findUnique.mockImplementation(async ({ where }: { where: { name: string } }) =>
    where.name === 'campaign_type_builder' ? builderAgentRow : null,
  );
  prismaMock.campaignType.findUnique.mockResolvedValue(null);
  prismaMock.agentConfig.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: `cfg_${data.name as string}`,
    ...data,
  }));
  prismaMock.agentConfigHistory.create.mockResolvedValue({});
  prismaMock.campaignType.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'ct_new',
    ...data,
  }));
});

describe('campaignTypeBuilderService.buildDraft', () => {
  it('returns a complete draft and creates NO live agent_config rows', async () => {
    prismaMock.endpoint.findMany.mockResolvedValue([
      { id: 'ep_or', provider: 'openrouter', enabled: true },
    ]);

    const draft = await campaignTypeBuilderService.buildDraft({
      goal_description: 'Договориться о госте в подкасте',
    });

    // Draft completeness.
    expect(draft.goalSchema).toBeTruthy();
    expect(draft.safetyProfile.allowed_topics).toContain('подкаст');
    expect(draft.agents.map((a) => a.role).sort()).toEqual([...BUILDER_REQUIRED_ROLES].sort());
    expect(draft.unavailableTiers).toEqual([]);
    // Per-agent dry-run results attached (3.3).
    expect(draft.testResults).toHaveLength(BUILDER_REQUIRED_ROLES.length);
    expect(draft.testResults.every((r) => r.ran)).toBe(true);
    expect(draft.testResults.some((r) => r.tokensIn > 0)).toBe(true);

    // CRITICAL: no live agent_config rows exist before save.
    expect(prismaMock.agentConfig.create).not.toHaveBeenCalled();
    expect(prismaMock.campaignType.create).not.toHaveBeenCalled();
    expect(prismaMock.agentConfigHistory.create).not.toHaveBeenCalled();
  });

  it('binds every drafted agent to an endpoint when all tiers are covered', async () => {
    prismaMock.endpoint.findMany.mockResolvedValue([
      { id: 'ep_or', provider: 'openrouter', enabled: true },
    ]);
    const draft = await campaignTypeBuilderService.buildDraft({ goal_description: 'g' });
    // openrouter maps every tier, so each agent gets a real endpoint+model.
    for (const a of draft.agents) {
      expect(a.tierAvailable).toBe(true);
      expect(a.endpointId).toBe('ep_or');
      expect(a.model).toBeTruthy();
    }
  });

  it('throws (no dangling builder run) when no endpoint maps any tier', async () => {
    // A provider with no entry in the capability map → no tier resolves, so
    // even the meta-agent can't run. The service reports the gap by throwing
    // a 400 rather than emitting an unusable draft.
    prismaMock.endpoint.findMany.mockResolvedValue([
      { id: 'ep_x', provider: 'unknown_provider', enabled: true },
    ]);
    await expect(
      campaignTypeBuilderService.buildDraft({ goal_description: 'g' }),
    ).rejects.toBeTruthy();
    expect(prismaMock.agentConfig.create).not.toHaveBeenCalled();
  });
});

describe('campaignTypeBuilderService.saveDraft', () => {
  it('creates campaign_type + v1 agent_config rows recorded in history; audits', async () => {
    prismaMock.endpoint.findMany.mockResolvedValue([
      { id: 'ep_or', provider: 'openrouter', enabled: true },
    ]);
    const draft = await campaignTypeBuilderService.buildDraft({ goal_description: 'g' });

    // No live rows yet.
    expect(prismaMock.agentConfig.create).not.toHaveBeenCalled();

    const saved = await campaignTypeBuilderService.saveDraft(draft, 'admin1');

    expect(saved.key).toBe('podcast_guesting');
    // One agent_config per drafted agent, each with version 1.
    expect(prismaMock.agentConfig.create).toHaveBeenCalledTimes(draft.agents.length);
    for (const call of prismaMock.agentConfig.create.mock.calls) {
      expect(call[0].data.version).toBe(1);
    }
    // History v1 written per agent.
    expect(prismaMock.agentConfigHistory.create).toHaveBeenCalledTimes(draft.agents.length);
    // Campaign type created.
    expect(prismaMock.campaignType.create).toHaveBeenCalledTimes(1);
    // Audited.
    expect(prismaMock.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.auditLog.create.mock.calls[0]?.[0].data.action).toBe(
      'campaign_type.build_save',
    );
  });

  it('refuses to save a reserved built-in key', async () => {
    prismaMock.endpoint.findMany.mockResolvedValue([
      { id: 'ep_or', provider: 'openrouter', enabled: true },
    ]);
    const draft = await campaignTypeBuilderService.buildDraft({ goal_description: 'g' });
    const reserved = { ...draft, key: 'custdev' };
    await expect(campaignTypeBuilderService.saveDraft(reserved, 'admin1')).rejects.toBeTruthy();
    expect(prismaMock.agentConfig.create).not.toHaveBeenCalled();
  });
});
