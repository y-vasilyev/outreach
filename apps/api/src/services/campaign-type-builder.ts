import { randomUUID } from 'node:crypto';

import { getPrisma, type AgentConfig as DbAgentConfig } from '@nosquare/db';
import {
  Errors,
  resolveCapabilityMap,
  ROLE_TIER,
  BUILTIN_CAMPAIGN_TYPE_KEYS,
  type ModelTier,
  type TierResolution,
  type BuildCampaignTypeInput,
  type CampaignTypeDraft,
  type DraftAgentConfig,
  type DraftAgentTestResult,
} from '@nosquare/shared';
import {
  campaignTypeBuilderOutputSchema,
  BUILDER_REQUIRED_ROLES,
} from '@nosquare/agents';

import { getAgentRunner } from './agents.js';
import { campaignTypesService } from './campaign-types.js';
import { auditService } from './audit.js';
import { logger } from '../logger.js';

const BUILDER_AGENT_NAME = 'campaign_type_builder';

/**
 * Roles whose registered agent implementation produces structured JSON. Used
 * to decide whether a drafted role carries an output JSON-schema and which
 * fixture to dry-run it against.
 */
const STRUCTURED_ROLES = new Set([
  'intent_classifier',
  'safety_filter',
  'goal_fit_evaluator',
]);

/**
 * In-memory store of drafts pending operator review. A draft is ephemeral
 * (never persisted as live config — Decision D3) and is consumed on save.
 * Bounded so a forgotten draft can't leak memory.
 */
const draftStore = new Map<string, CampaignTypeDraft>();
const DRAFT_TTL_MS = 60 * 60 * 1000;
const draftCreatedAt = new Map<string, number>();

function pruneDrafts(): void {
  const now = Date.now();
  for (const [id, at] of draftCreatedAt) {
    if (now - at > DRAFT_TTL_MS) {
      draftStore.delete(id);
      draftCreatedAt.delete(id);
    }
  }
}

/**
 * Minimal, role-keyed test fixtures for the dry-run pass (task 3.3). Each
 * fixture is shaped to satisfy the registered agent implementation's
 * `inputSchema` for that role. We keep them tiny — the goal is to exercise
 * the drafted prompt end-to-end and surface token/cost/latency, not to
 * golden-test output.
 */
function fixtureForRole(role: string): Record<string, unknown> {
  switch (role) {
    case 'opening_composer':
      return {
        channel_analysis: { topic: 'финтех', tone: 'casual' },
        contact: { value: 'founder', role_guess: 'owner' },
        strategy: { approach: 'industry_fit', hook: 'свежий пост про комиссии', why_them: 'релевантная аудитория', tone: 'peer', do_avoid: [] },
        campaign: { goal_text: 'короткое интервью', value_prop: 'портфолио канала' },
      };
    case 'reply_composer':
      return {
        channel_analysis: { topic: 'финтех', tone: 'casual' },
        contact: { value: 'founder', role_guess: 'owner' },
        campaign: { goal_text: 'короткое интервью' },
        conversation_history: [
          { direction: 'out', sender: 'me', text: 'Привет, можно задать пару вопросов?', at: '2026-05-20T10:00:00Z' },
          { direction: 'in', sender: 'them', text: 'Да, давай', at: '2026-05-20T10:05:00Z' },
        ],
        last_inbound: { text: 'Да, давай', intent: 'interested', sentiment: 'positive' },
      };
    case 'intent_classifier':
      return {
        last_inbound: 'Сколько это стоит и какие форматы есть?',
        history_tail: ['Привет, есть пара вопросов', 'Да, слушаю'],
      };
    case 'safety_filter':
      return {
        draft: 'Привет, можно задать пару вопросов про ваш канал на 15 минут?',
        channel_analysis: { topic: 'финтех' },
        contact: { value: 'founder' },
        campaign: { goal_text: 'интервью' },
      };
    case 'goal_fit_evaluator':
      return {
        ajtbd: {
          job: 'Провести интервью',
          when: 'когда автор получает входящие',
          forces: { push: [], pull: [], anxieties: [], habits: [] },
          desired_outcome: 'согласие на интервью',
          non_goals: ['продажа рекламы'],
        },
        history_tail: ['Привет', 'Да, слушаю'],
        intent: { intent: 'interested', confidence: 0.8 },
        handoff: { action: 'ai_continue', reason: 'on track' },
        draft: 'Спасибо! Когда удобно созвониться на 15 минут?',
        previous_decision: null,
      };
    default:
      // Forward-looking / type-specific roles (extractors, planner). Provide a
      // generic bag; the dry-run will report a validation error which the
      // operator sees alongside the draft instead of a silent skip.
      return { input: 'fixture', goal_description: 'test' };
  }
}

export const campaignTypeBuilderService = {
  /**
   * 3.2 + 3.3: run the meta-agent to draft a type, deterministically resolve
   * each role's model tier to an available endpoint via the capability map,
   * then dry-run each drafted agent against a fixture and attach results.
   * Persists NOTHING (Decision D3).
   */
  async buildDraft(input: BuildCampaignTypeInput): Promise<CampaignTypeDraft> {
    const prisma = getPrisma();
    const runner = getAgentRunner();

    // Resolve the capability map against the endpoints actually configured.
    const endpoints = await prisma.endpoint.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, provider: true, enabled: true },
    });
    const tierResolution = resolveCapabilityMap(
      endpoints.map((e) => ({ id: e.id, provider: e.provider, enabled: e.enabled })),
    );
    const unavailableTiers = (['cheap', 'medium', 'strong'] as ModelTier[]).filter(
      (t) => !tierResolution[t].available,
    );

    // Bind the builder meta-agent itself to a strong (then any) available
    // endpoint so it can run even on a partially-configured deployment.
    const builderTier = pickAvailableTier('strong', tierResolution);
    if (!builderTier) {
      throw Errors.badRequest(
        'no LLM endpoint is configured — the campaign-type builder needs at least one enabled endpoint',
      );
    }
    const builderDbConfig = await prisma.agentConfig.findUnique({
      where: { name: BUILDER_AGENT_NAME },
    });
    if (!builderDbConfig) throw Errors.notFound('agent_config', BUILDER_AGENT_NAME);

    const builderConfig: DbAgentConfig = {
      ...builderDbConfig,
      endpointId: builderTier.endpointId,
      model: builderTier.model ?? builderDbConfig.model,
    };

    // 3.2: draft the type via the meta-agent (inline config; not persisted).
    const raw = await runner.dryRunConfig<unknown>(
      BUILDER_AGENT_NAME,
      builderConfig,
      {
        goal_description: input.goal_description,
        examples: input.examples ?? [],
        constraints: input.constraints ?? {},
        required_roles: [...BUILDER_REQUIRED_ROLES],
      },
    );
    const drafted = campaignTypeBuilderOutputSchema.parse(raw.output);

    // Avoid colliding with reserved built-in keys; suffix if needed.
    let key = drafted.key;
    if ((BUILTIN_CAMPAIGN_TYPE_KEYS as readonly string[]).includes(key)) {
      key = `${key}_custom`;
    }

    // Build per-role draft agent configs, binding each to its tier endpoint.
    const draftId = randomUUID();
    const agents: DraftAgentConfig[] = [];
    const agentSet: Record<string, { agentName: string; overrides: Record<string, unknown> }> = {};

    for (const a of drafted.agents) {
      const role = a.role;
      const tier = ROLE_TIER[role] ?? 'medium';
      const res = tierResolution[tier];
      const name = `${key}_${role}`;
      const structured = STRUCTURED_ROLES.has(role) || a.outputJsonSchema !== null;
      const params: Record<string, unknown> = {};
      if (structured && a.outputJsonSchema) {
        params.json_schema = a.outputJsonSchema;
      }
      agents.push({
        role,
        name,
        description: a.description ?? '',
        tier,
        endpointId: res.available ? res.endpointId : null,
        provider: res.available ? res.provider : null,
        model: res.available ? res.model : null,
        tierAvailable: res.available,
        systemPrompt: a.systemPrompt,
        userPromptTemplate: a.userPromptTemplate,
        params,
        outputJsonSchema: a.outputJsonSchema ?? null,
      });
      agentSet[role] = { agentName: name, overrides: {} };
    }

    // 3.3: dry-run each drafted agent against a fixture; attach results.
    const testResults: DraftAgentTestResult[] = [];
    for (const a of agents) {
      if (!a.tierAvailable || !a.endpointId) {
        testResults.push({
          role: a.role,
          name: a.name,
          ran: false,
          skippedReason: `no endpoint available for tier "${a.tier}"`,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          latencyMs: 0,
          error: null,
        });
        continue;
      }
      const inlineConfig: DbAgentConfig = {
        ...builderDbConfig,
        name: a.name,
        role: a.role,
        endpointId: a.endpointId,
        fallbackEndpointId: null,
        model: a.model ?? '',
        systemPrompt: a.systemPrompt,
        userPromptTemplate: a.userPromptTemplate,
        params: a.params as object,
      };
      try {
        // Run the ROLE's registered implementation with the drafted prompts.
        const result = await runner.dryRunConfig<unknown>(
          a.role,
          inlineConfig,
          fixtureForRole(a.role),
        );
        testResults.push({
          role: a.role,
          name: a.name,
          ran: true,
          skippedReason: null,
          output: result.output,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          costUsd: result.costUsd,
          latencyMs: result.latencyMs,
          error: null,
        });
      } catch (e) {
        testResults.push({
          role: a.role,
          name: a.name,
          ran: true,
          skippedReason: null,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          latencyMs: 0,
          error: e instanceof Error ? e.message : String(e),
        });
        logger.warn(
          { event: 'builder.dryRunFailed', role: a.role, err: (e as Error).message },
          'drafted agent dry-run failed',
        );
      }
    }

    const draft: CampaignTypeDraft = {
      draftId,
      key,
      name: drafted.name,
      description: drafted.description ?? '',
      goalSchema: drafted.goalSchema,
      safetyProfile: drafted.safetyProfile,
      autonomyPolicy: drafted.autonomyPolicy,
      agentSet,
      agents,
      testResults,
      unavailableTiers,
    };

    pruneDrafts();
    draftStore.set(draftId, draft);
    draftCreatedAt.set(draftId, Date.now());
    return draft;
  },

  /** 3.5: fetch a previously-built draft (with its dry-run results). */
  getDraft(draftId: string): CampaignTypeDraft {
    const d = draftStore.get(draftId);
    if (!d) throw Errors.notFound('campaign_type_draft', draftId);
    return d;
  },

  /**
   * 3.4: persist a reviewed draft. Creates the `campaign_type` row and a real
   * `agent_config` row per drafted agent (version 1, recorded in
   * `agent_config_history`). Never auto-publishes before this explicit save.
   * Audited by the route.
   */
  async saveDraft(
    draft: CampaignTypeDraft,
    actorId: string | null,
  ): Promise<{ id: string; key: string }> {
    const prisma = getPrisma();

    if ((BUILTIN_CAMPAIGN_TYPE_KEYS as readonly string[]).includes(draft.key)) {
      throw Errors.badRequest(`campaign type key "${draft.key}" is reserved`, {
        key: draft.key,
      });
    }
    const existingType = await prisma.campaignType.findUnique({ where: { key: draft.key } });
    if (existingType) {
      throw Errors.conflict(`campaign type "${draft.key}" already exists`);
    }
    for (const a of draft.agents) {
      const dupe = await prisma.agentConfig.findUnique({ where: { name: a.name } });
      if (dupe) {
        throw Errors.conflict(`agent config "${a.name}" already exists`);
      }
    }

    const created = await prisma.$transaction(async (tx) => {
      for (const a of draft.agents) {
        const cfg = await tx.agentConfig.create({
          data: {
            name: a.name,
            role: a.role,
            description: a.description,
            endpointId: a.endpointId,
            model: a.model ?? '',
            systemPrompt: a.systemPrompt,
            userPromptTemplate: a.userPromptTemplate,
            params: a.params as object,
            enabled: true,
            version: 1,
            updatedById: actorId,
          },
        });
        // Record v1 in history so the agent UI shows a baseline version.
        await tx.agentConfigHistory.create({
          data: {
            agentConfigId: cfg.id,
            version: 1,
            snapshot: {
              model: cfg.model,
              systemPrompt: cfg.systemPrompt,
              userPromptTemplate: cfg.userPromptTemplate,
              params: cfg.params,
              endpointId: cfg.endpointId,
              fallbackEndpointId: cfg.fallbackEndpointId,
              enabled: cfg.enabled,
            },
            changedById: actorId,
          },
        });
      }

      return tx.campaignType.create({
        data: {
          key: draft.key,
          name: draft.name,
          description: draft.description,
          goalSchema: draft.goalSchema as object,
          agentSet: draft.agentSet as object,
          safetyProfile: draft.safetyProfile as object,
          autonomyPolicy: draft.autonomyPolicy as object,
          builtIn: false,
          enabled: true,
        },
      });
    });

    // Consume the in-memory draft once saved.
    draftStore.delete(draft.draftId);
    draftCreatedAt.delete(draft.draftId);

    // Reuse the registry validator path for parity (no-op success here).
    void campaignTypesService;

    await auditService.log({
      userId: actorId,
      action: 'campaign_type.build_save',
      targetType: 'campaign_type',
      targetId: created.id,
      payload: { key: created.key, agents: draft.agents.map((a) => a.name) },
    });

    return { id: created.id, key: created.key };
  },
};

/**
 * Pick the requested tier if available, else fall back to the next-best
 * available tier (medium → cheap → strong order of preference for "any").
 */
function pickAvailableTier(
  preferred: ModelTier,
  resolution: Record<ModelTier, TierResolution>,
): TierResolution | null {
  if (resolution[preferred].available) return resolution[preferred];
  const order: ModelTier[] = ['strong', 'medium', 'cheap'];
  for (const t of order) {
    if (resolution[t].available) return resolution[t];
  }
  return null;
}
