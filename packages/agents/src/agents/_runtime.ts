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
import { renderSchemaHints } from '../schemaHints.js';

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

  // Auto-derive enum hints from the output schema and inject them. If the
  // prompt has a `{{__schema_hints}}` placeholder, render there; otherwise
  // append to the system prompt with a separator. Empty for schemas that
  // contain no ZodEnum / ZodNativeEnum / discriminated string-literal union.
  const schemaHints = renderSchemaHints(outputSchema);
  const varsWithHints = { ...vars, __schema_hints: schemaHints };

  let systemPrompt = renderTemplate(systemTpl, varsWithHints, ctx.logger);
  const userPrompt = renderTemplate(userTpl, varsWithHints, ctx.logger);

  if (schemaHints && !systemTpl.includes('{{__schema_hints}}') && !userTpl.includes('{{__schema_hints}}')) {
    systemPrompt = systemPrompt
      ? `${systemPrompt}\n\n${schemaHints}`
      : schemaHints;
  }

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
    parseJsonStrict(raw, (v) => outputSchema.parse(stripNulls(v)) as z.infer<S>),
  );
  return value;
}

/**
 * Recursively replace `null` values with `undefined`. Why:
 *
 * LLMs (especially when JSON-mode is on) emit `null` as the "no value"
 * sentinel — `"rewrite_hint": null`, `"summary": null`. Our schemas use
 * `z.X.optional()` which only accepts `string | undefined`, not `null`.
 * Rejecting these responses wastes a turn (or a whole repair pass for
 * something the model would just emit again the same way). Stripping
 * `null` once at the boundary is the cheap, robust fix.
 *
 * For object fields: delete the key (turning into `undefined` on read).
 * For array elements: leave as-is (some agents expect arrays of nullable
 *   items; we don't want to silently shorten arrays).
 */
function stripNulls(v: unknown): unknown {
  if (v === null) return undefined;
  if (Array.isArray(v)) {
    return v.map((item) => stripNulls(item));
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === null) continue; // drop `null` keys
      out[k] = stripNulls(val);
    }
    return out;
  }
  return v;
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
