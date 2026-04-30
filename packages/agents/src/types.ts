/**
 * Agent contract & runtime context types.
 *
 * Agents have heterogeneous input/output shapes. We keep the schema field
 * loose (ZodTypeAny) — schemas are still used for runtime validation in
 * AgentRunner — and parameterise Agent by the inferred TIn/TOut TS types
 * so the run() signature stays strongly typed at the call site.
 */
import type { ZodTypeAny } from 'zod';

import type { LLMProvider } from '@nosquare/llm';
import type { AgentConfig as DbAgentConfig } from '@nosquare/db';

export type LogFn = (...args: unknown[]) => void;

export interface AgentLogger {
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  debug: LogFn;
}

export interface AgentRunCtx {
  llm: LLMProvider;
  config: DbAgentConfig;
  logger: AgentLogger;
  runId: string;
  channelId?: string;
  contactId?: string;
  conversationId?: string;
  campaignId?: string;
}

export interface Agent<TIn = unknown, TOut = unknown> {
  name: string;
  description: string;
  inputSchema: ZodTypeAny;
  outputSchema: ZodTypeAny;
  variables: string[];
  defaultModel?: string;
  defaultParams?: Record<string, unknown>;
  run(input: TIn, ctx: AgentRunCtx): Promise<TOut>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAgent = Agent<any, any>;
