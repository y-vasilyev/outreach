import { vi } from 'vitest';

import type { LLMProvider } from '@nosquare/llm';
import type { AgentConfig as DbAgentConfig } from '@nosquare/db';

import type { AgentLogger, AgentRunCtx } from '../types.js';

export function makeLogger(): AgentLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/**
 * Build an LLMProvider mock. `completeJsonImpl` lets a test declare what JSON
 * value the LLM should return for `completeJson` calls. If the LLM is never
 * called, tests can assert via vi.fn().mock.calls.length === 0.
 */
export function makeLLM(opts: {
  completeJsonImpl?: (req: unknown) => unknown;
  completeImpl?: (req: unknown) => string;
} = {}): LLMProvider & { _calls: { completeJson: number; complete: number } } {
  const calls = { completeJson: 0, complete: 0 };
  const provider: LLMProvider = {
    kind: 'openrouter',
    estimateTokens: () => 1,
    listModels: async () => [],
    async complete(req) {
      calls.complete += 1;
      const text = opts.completeImpl ? opts.completeImpl(req) : '';
      return {
        text,
        tokensIn: 1,
        tokensOut: 1,
        costUsd: 0,
        model: req.model,
      };
    },
    async completeJson(req, parser) {
      calls.completeJson += 1;
      const value = opts.completeJsonImpl
        ? opts.completeJsonImpl(req)
        : ({} as unknown);
      return {
        value: parser(JSON.stringify(value)) as never,
        meta: {
          text: JSON.stringify(value),
          tokensIn: 1,
          tokensOut: 1,
          costUsd: 0,
          model: req.model,
        },
      };
    },
  };
  return Object.assign(provider, { _calls: calls });
}

export function makeConfig(over: Partial<DbAgentConfig> = {}): DbAgentConfig {
  const base = {
    id: 'cfg_test',
    name: 'test',
    role: '',
    description: '',
    endpointId: 'ep_test',
    fallbackEndpointId: null,
    model: 'test-model',
    systemPrompt: 'sys',
    userPromptTemplate: 'user {{x}}',
    params: {},
    enabled: true,
    version: 1,
    updatedById: null,
    updatedAt: new Date(),
    createdAt: new Date(),
  } as unknown as DbAgentConfig;
  return { ...base, ...over } as DbAgentConfig;
}

export function makeCtx(opts: {
  llm?: LLMProvider;
  config?: DbAgentConfig;
} = {}): AgentRunCtx {
  return {
    llm: opts.llm ?? makeLLM(),
    config: opts.config ?? makeConfig(),
    logger: makeLogger(),
    runId: 'run_test',
  };
}
