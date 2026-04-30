import { randomUUID } from 'node:crypto';

import pino from 'pino';

import { Errors, isAppError, AppError } from '@nosquare/shared/errors';
import {
  createProvider,
  withFallback,
  withTokenAccounting,
  type LLMProvider,
  type ProviderConfig,
  type ProviderKind,
  type TokenAccountingRun,
} from '@nosquare/llm';
import type { AgentConfig as DbAgentConfig, PrismaClient } from '@nosquare/db';

import { agentRegistry } from './registry.js';
import type { AgentLogger, AgentRunCtx, AnyAgent } from './types.js';

const rootLogger = pino({
  name: 'agent-runner',
  level: process.env.LOG_LEVEL ?? 'info',
});

export interface ResolvedEndpoint {
  provider: ProviderKind;
  baseUrl: string;
  apiKey: string;
  folderId?: string;
  iamToken?: string;
  defaultHeaders?: Record<string, string>;
  /** Optional per-endpoint timeout override forwarded to ProviderConfig. */
  timeoutMs?: number;
}

/**
 * Resolves an `endpoint_id` (DB row id) into ready-to-use credentials.
 *
 * The runner does NOT decrypt `auth_encrypted` itself — callers (workers /
 * api boot) wire a resolver that knows how to decrypt and assemble the
 * `ProviderConfig`. This keeps the agents package independent of crypto
 * lifecycle and keeps secrets out of unit tests.
 */
export type EndpointResolver = (
  endpointId: string | null,
) => Promise<ResolvedEndpoint>;

export interface RunnerOptions {
  prisma: PrismaClient;
  endpointResolver: EndpointResolver;
  logger?: pino.Logger;
}

export interface RunCtxIds {
  channelId?: string;
  contactId?: string;
  conversationId?: string;
  campaignId?: string;
}

export interface RunOptions extends RunCtxIds {
  /** Campaign-level partial config that should override the DB record. */
  overrides?: Partial<DbAgentConfig>;
}

interface TokenAccumulator {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  calls: number;
  providerUsed?: string;
}

const tokenStore = new Map<string, TokenAccumulator>();

function freshAcc(): TokenAccumulator {
  return { tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: 0, calls: 0 };
}

/** Internal: returns a hook keyed to a specific runId. */
function makeAccountingHook(runId: string) {
  return (run: TokenAccountingRun): void => {
    const acc = tokenStore.get(runId) ?? freshAcc();
    acc.tokensIn += run.tokensIn;
    acc.tokensOut += run.tokensOut;
    acc.costUsd += run.costUsd;
    acc.latencyMs += run.latencyMs;
    acc.calls += 1;
    tokenStore.set(runId, acc);
  };
}

function takeAcc(runId: string): TokenAccumulator {
  const acc = tokenStore.get(runId) ?? freshAcc();
  tokenStore.delete(runId);
  return acc;
}

export class AgentRunner {
  private readonly prisma: PrismaClient;
  private readonly endpointResolver: EndpointResolver;
  private readonly logger: pino.Logger;

  constructor(opts: RunnerOptions) {
    this.prisma = opts.prisma;
    this.endpointResolver = opts.endpointResolver;
    this.logger = opts.logger ?? rootLogger;
  }

  /**
   * Resolves config + provider, runs the agent, persists `agent_run`.
   * Throws AppError on any failure; on agent error a `failed` row is written
   * before the error is re-thrown.
   */
  async run<T>(
    agentName: string,
    input: unknown,
    ctx?: RunOptions,
  ): Promise<T> {
    const started = Date.now();
    const runId = randomUUID();
    const log = this.logger.child({ runId, agent: agentName, ...ctx });

    // 1. Load agent_config from DB.
    const dbConfig = await this.prisma.agentConfig.findUnique({
      where: { name: agentName },
    });
    if (!dbConfig) {
      throw Errors.notFound('agent_config', agentName);
    }
    if (dbConfig.enabled === false) {
      throw new AppError('FORBIDDEN', `agent ${agentName} disabled`, 403);
    }

    // 2. Apply overrides (shallow merge over DB record).
    const config: DbAgentConfig = ctx?.overrides
      ? ({ ...dbConfig, ...ctx.overrides } as DbAgentConfig)
      : dbConfig;

    // 3. Look up the agent from the registry & validate input.
    const agent = agentRegistry.get(agentName);
    let parsedInput: unknown;
    try {
      parsedInput = agent.inputSchema.parse(input);
    } catch (e) {
      throw Errors.badRequest(`invalid input for agent ${agentName}`, {
        message: (e as Error).message,
      });
    }

    // 4. Resolve endpoint and build LLM provider.
    let provider: LLMProvider;
    try {
      provider = await this.buildProvider(config, runId);
    } catch (e) {
      // Record a failed run so token/cost dashboards stay consistent.
      await this.persistRun({
        runId,
        agent,
        config,
        ctx,
        input: parsedInput,
        output: null,
        acc: freshAcc(),
        status: 'failed',
        startedAt: started,
        error: (e as Error).message ?? 'endpoint resolution failed',
      });
      if (isAppError(e)) throw e;
      throw Errors.internal('failed to build LLM provider', {
        message: (e as Error).message,
      });
    }

    // 5. Build context.
    const agentLogger: AgentLogger = {
      info: (...args) => log.info(args.length === 1 ? args[0] : args),
      warn: (...args) => log.warn(args.length === 1 ? args[0] : args),
      error: (...args) => log.error(args.length === 1 ? args[0] : args),
      debug: (...args) => log.debug(args.length === 1 ? args[0] : args),
    };

    const runCtx: AgentRunCtx = {
      llm: provider,
      config,
      logger: agentLogger,
      runId,
      ...(ctx?.channelId !== undefined && { channelId: ctx.channelId }),
      ...(ctx?.contactId !== undefined && { contactId: ctx.contactId }),
      ...(ctx?.conversationId !== undefined && { conversationId: ctx.conversationId }),
      ...(ctx?.campaignId !== undefined && { campaignId: ctx.campaignId }),
    };

    log.info({ event: 'agent.runStart' }, 'agent run start');

    let output: unknown;
    try {
      output = await agent.run(parsedInput, runCtx);
      // Validate output too — agents are responsible for shape, but a defensive
      // re-parse here catches drift between hand-written run() and outputSchema.
      try {
        output = agent.outputSchema.parse(output);
      } catch (e) {
        throw Errors.upstream(`agent ${agentName} output failed validation`, {
          message: (e as Error).message,
        });
      }
    } catch (e) {
      const acc = takeAcc(runId);
      await this.persistRun({
        runId,
        agent,
        config,
        ctx,
        input: parsedInput,
        output: null,
        acc,
        status: 'failed',
        startedAt: started,
        error: e instanceof Error ? e.message : String(e),
      });
      log.error({ event: 'agent.runFailed', err: (e as Error).message }, 'agent run failed');
      if (isAppError(e)) throw e;
      throw Errors.internal(`agent ${agentName} failed`, {
        message: (e as Error).message,
      });
    }

    const acc = takeAcc(runId);
    await this.persistRun({
      runId,
      agent,
      config,
      ctx,
      input: parsedInput,
      output,
      acc,
      status: acc.providerUsed && acc.providerUsed !== config.endpointId ? 'fallback' : 'ok',
      startedAt: started,
    });

    log.info(
      {
        event: 'agent.runOk',
        latencyMs: Date.now() - started,
        tokensIn: acc.tokensIn,
        tokensOut: acc.tokensOut,
        costUsd: acc.costUsd,
      },
      'agent run ok',
    );

    return output as T;
  }

  /**
   * Like `run`, but does NOT persist `agent_run`. Used by the admin UI's
   * "Test" button to dry-run an agent without polluting telemetry.
   */
  async dryRun<T>(
    agentName: string,
    input: unknown,
  ): Promise<{
    output: T;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    latencyMs: number;
  }> {
    const started = Date.now();
    const runId = randomUUID();
    const log = this.logger.child({ runId, agent: agentName, dryRun: true });

    const dbConfig = await this.prisma.agentConfig.findUnique({
      where: { name: agentName },
    });
    if (!dbConfig) throw Errors.notFound('agent_config', agentName);

    const agent = agentRegistry.get(agentName);
    const parsedInput = agent.inputSchema.parse(input);

    const provider = await this.buildProvider(dbConfig, runId);

    const agentLogger: AgentLogger = {
      info: (...args) => log.info(args.length === 1 ? args[0] : args),
      warn: (...args) => log.warn(args.length === 1 ? args[0] : args),
      error: (...args) => log.error(args.length === 1 ? args[0] : args),
      debug: (...args) => log.debug(args.length === 1 ? args[0] : args),
    };

    const ctx: AgentRunCtx = {
      llm: provider,
      config: dbConfig,
      logger: agentLogger,
      runId,
    };

    let output: T;
    try {
      output = (await agent.run(parsedInput, ctx)) as T;
      output = agent.outputSchema.parse(output) as T;
    } finally {
      // Always pull the accumulator so we don't leak entries on error.
      // (Re-throw happens via finally + catch chain.)
    }
    const acc = takeAcc(runId);
    return {
      output,
      tokensIn: acc.tokensIn,
      tokensOut: acc.tokensOut,
      costUsd: acc.costUsd,
      latencyMs: Date.now() - started,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                          */
  /* ------------------------------------------------------------------ */

  private async buildProvider(
    config: DbAgentConfig,
    runId: string,
  ): Promise<LLMProvider> {
    const primaryRes = await this.endpointResolver(config.endpointId ?? null);
    const primary = createProvider(primaryRes.provider, toProviderConfig(primaryRes));

    let provider: LLMProvider;
    if (config.fallbackEndpointId) {
      const fbRes = await this.endpointResolver(config.fallbackEndpointId);
      const fallback = createProvider(fbRes.provider, toProviderConfig(fbRes));
      provider = withFallback(primary, fallback);
    } else {
      provider = primary;
    }

    // Token accounting wraps last so every call (primary or fallback) is
    // counted into the same runId-scoped accumulator.
    return withTokenAccounting(provider, makeAccountingHook(runId));
  }

  private async persistRun(args: {
    runId: string;
    agent: AnyAgent;
    config: DbAgentConfig;
    ctx?: RunCtxIds;
    input: unknown;
    output: unknown;
    acc: TokenAccumulator;
    status: 'ok' | 'fallback' | 'failed';
    startedAt: number;
    error?: string;
  }): Promise<void> {
    const { agent, config, ctx, input, output, acc, status, startedAt, error } = args;
    try {
      await this.prisma.agentRun.create({
        data: {
          agentName: agent.name,
          channelId: ctx?.channelId ?? null,
          contactId: ctx?.contactId ?? null,
          conversationId: ctx?.conversationId ?? null,
          endpointId: config.endpointId ?? null,
          model: config.model || null,
          input: input as object,
          output: (output ?? undefined) as object | undefined,
          tokensIn: acc.tokensIn,
          tokensOut: acc.tokensOut,
          costUsd: acc.costUsd,
          latencyMs: Date.now() - startedAt,
          status,
          error: error ?? null,
        },
      });
    } catch (e) {
      // Persisting telemetry must never crash the caller. Log and swallow.
      this.logger.error(
        { event: 'agent.runPersistFailed', err: (e as Error).message },
        'failed to persist agent_run',
      );
    }
  }
}

function toProviderConfig(r: ResolvedEndpoint): ProviderConfig {
  const cfg: ProviderConfig = {
    baseUrl: r.baseUrl,
    apiKey: r.apiKey,
  };
  if (r.folderId !== undefined) cfg.folderId = r.folderId;
  if (r.iamToken !== undefined) cfg.iamToken = r.iamToken;
  if (r.defaultHeaders !== undefined) cfg.defaultHeaders = r.defaultHeaders;
  if (r.timeoutMs !== undefined) cfg.timeoutMs = r.timeoutMs;
  return cfg;
}
