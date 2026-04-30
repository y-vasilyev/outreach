/**
 * Shared helpers for agent implementations.
 *
 * Agents follow a consistent pattern:
 *   1. Render system + user prompt from `ctx.config` using the agent's input
 *      as variable bag (plus any extra computed keys).
 *   2. Call `ctx.llm.completeJson` (or `complete` for free-text).
 *   3. Return validated output.
 *
 * Hardcoded fallback prompts live next to each agent — used ONLY when the
 * DB record's prompt fields are empty (which shouldn't happen if the seed
 * ran). This keeps tests and a fresh dev DB from blowing up.
 */

import { Errors } from '@nosquare/shared/errors';
import { parseJsonStrict } from '@nosquare/llm';
import type { ZodTypeAny, z } from 'zod';

import type { AgentRunCtx } from '../types.js';
import { renderTemplate } from '../promptRender.js';

export interface PromptVars {
  [k: string]: unknown;
}

export interface InvokeJsonOpts<S extends ZodTypeAny> {
  ctx: AgentRunCtx;
  vars: PromptVars;
  outputSchema: S;
  /** Hardcoded fallback used only when ctx.config.systemPrompt is empty. */
  fallbackSystemPrompt?: string;
  /** Hardcoded fallback used only when ctx.config.userPromptTemplate is empty. */
  fallbackUserPromptTemplate?: string;
}

/**
 * Invokes the LLM with structured-JSON expectations. Output is validated by
 * `outputSchema`. Returns the parsed value (`z.infer<S>`).
 */
export async function invokeJson<S extends ZodTypeAny>(
  opts: InvokeJsonOpts<S>,
): Promise<z.infer<S>> {
  const { ctx, vars, outputSchema, fallbackSystemPrompt, fallbackUserPromptTemplate } = opts;
  const systemTpl = ctx.config.systemPrompt || fallbackSystemPrompt || '';
  const userTpl = ctx.config.userPromptTemplate || fallbackUserPromptTemplate || '';
  if (!systemTpl && !userTpl) {
    throw Errors.internal(
      `agent ${ctx.config.name}: both systemPrompt and userPromptTemplate are empty`,
    );
  }

  const systemPrompt = renderTemplate(systemTpl, vars, ctx.logger);
  const userPrompt = renderTemplate(userTpl, vars, ctx.logger);

  const params = readParams(ctx.config.params);
  const req = {
    systemPrompt,
    userPrompt,
    model: ctx.config.model || 'default',
    jsonMode: true,
    ...(typeof params.temperature === 'number' && { temperature: params.temperature }),
    ...(typeof params.max_tokens === 'number' && { maxTokens: params.max_tokens }),
    ...(typeof params.top_p === 'number' && { topP: params.top_p }),
    ...(params.json_schema !== undefined && { responseSchema: params.json_schema }),
  };

  const { value } = await ctx.llm.completeJson<z.infer<S>>(req, (raw: string) =>
    parseJsonStrict(raw, (v) => outputSchema.parse(v) as z.infer<S>),
  );
  return value;
}

/** Same as invokeJson but for free-text completions (no agent in this list uses it). */
export async function invokeText(
  ctx: AgentRunCtx,
  vars: PromptVars,
  fallbacks?: { system?: string; user?: string },
): Promise<string> {
  const systemTpl = ctx.config.systemPrompt || fallbacks?.system || '';
  const userTpl = ctx.config.userPromptTemplate || fallbacks?.user || '';
  const systemPrompt = renderTemplate(systemTpl, vars, ctx.logger);
  const userPrompt = renderTemplate(userTpl, vars, ctx.logger);

  const params = readParams(ctx.config.params);
  const req = {
    systemPrompt,
    userPrompt,
    model: ctx.config.model || 'default',
    ...(typeof params.temperature === 'number' && { temperature: params.temperature }),
    ...(typeof params.max_tokens === 'number' && { maxTokens: params.max_tokens }),
    ...(typeof params.top_p === 'number' && { topP: params.top_p }),
  };
  const res = await ctx.llm.complete(req);
  return res.text;
}

/** Read agent params, normalised to a plain object. */
export function readParams(p: unknown): Record<string, unknown> {
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    return p as Record<string, unknown>;
  }
  return {};
}
