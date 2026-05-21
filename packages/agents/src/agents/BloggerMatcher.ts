import { z } from 'zod';

import type { Agent } from '../types.js';
import { invokeJson, readParams } from './_runtime.js';

/**
 * BloggerMatcher — `blogger_matcher` (agency-sourcing-matching M7, task 7.4).
 *
 * OPTIONAL LLM re-rank of the top N deterministically-scored shortlist
 * candidates for nuanced fit. Two hard guarantees (spec "Optional LLM re-rank
 * is bounded"):
 *
 *   1. Re-rank is bounded to the candidates passed in (the caller slices the
 *      shortlist to top N before invoking — at most N reach the model).
 *   2. With re-rank disabled (`params.enable_llm_rerank !== true`, the default)
 *      the agent issues NO LLM call and returns the input order untouched.
 *
 * The agent only reorders / re-annotates the candidates it receives; the
 * caller stitches the LLM result back over the deterministic tail. The agent
 * never invents or drops a candidate — output is constrained to the input id
 * set and the agent re-attaches deterministic scores for any id the model
 * omits.
 */

const candidateInZ = z.object({
  profile_id: z.string(),
  score: z.number().min(0).max(1),
  rationale: z.string().default(''),
  /** Compact profile facts the model can reason over. */
  topics: z.array(z.string()).default([]),
  languages: z.array(z.string()).default([]),
  formats: z.array(z.string()).default([]),
  geo: z.array(z.string()).default([]),
  rate_cards: z
    .array(z.object({ format: z.string(), price: z.number(), currency: z.string().default('RUB') }))
    .default([]),
  reach: z.number().nullable().default(null),
});

export const bloggerMatcherInputSchema = z.object({
  brief: z.object({
    topic: z.string(),
    audience_target: z.string().default(''),
    budget: z.number().nullable().default(null),
    formats: z.array(z.string()).default([]),
    geo: z.array(z.string()).default([]),
    notes: z.string().default(''),
  }),
  candidates: z.array(candidateInZ),
});

export const bloggerMatcherOutputSchema = z.object({
  ranked: z.array(
    z.object({
      profile_id: z.string(),
      score: z.number().min(0).max(1),
      rationale: z.string().default(''),
    }),
  ),
});

export type BloggerMatcherInput = z.infer<typeof bloggerMatcherInputSchema>;
export type BloggerMatcherOutput = z.infer<typeof bloggerMatcherOutputSchema>;

const FALLBACK_SYSTEM = `Ты — медиабайер агентства. Тебе дают бриф клиента и КОРОТКИЙ список блогеров-кандидатов, уже отобранных и предварительно оценённых детерминированным алгоритмом (score 0..1). Твоя задача — переранжировать ИМЕННО этих кандидатов по нюансному соответствию брифу (тематика, аудитория, форматы, бюджет vs прайс), которое алгоритм мог упустить.

ПРАВИЛА:
- Работай ТОЛЬКО с переданными profile_id. НЕ добавляй и НЕ выдумывай новых.
- Можешь скорректировать score (0..1) и rationale, но оставайся близко к данным; не завышай при превышении бюджета.
- Верни ВСЕ переданные profile_id (если сомневаешься — оставь исходный score и rationale).
- rationale — короткое человекочитаемое объяснение, ссылайся на прайс/гео/форматы.

Возвращай только JSON: { ranked: [{ profile_id, score, rationale }] } по убыванию score.`;

const FALLBACK_USER = `Бриф клиента: {{brief}}

Кандидаты (предварительный score от алгоритма):
{{candidates}}

Верни JSON: переранжируй кандидатов. Только эти profile_id.`;

export const bloggerMatcher: Agent<BloggerMatcherInput, BloggerMatcherOutput> = {
  name: 'blogger_matcher',
  description:
    'Опциональный LLM-реранкинг топ-N кандидатов под бриф клиента; работает и без LLM (детерминированный путь).',
  inputSchema: bloggerMatcherInputSchema,
  outputSchema: bloggerMatcherOutputSchema,
  variables: ['brief', 'candidates'],
  defaultModel: 'google/gemini-3-flash-preview',
  defaultParams: { temperature: 0.2, max_tokens: 800, enable_llm_rerank: false },
  async run(input, ctx) {
    const params = readParams(ctx.config.params);
    const useLLM = params.enable_llm_rerank === true;

    // Deterministic path: no LLM call, keep the input (already-ranked) order.
    if (!useLLM || input.candidates.length === 0) {
      return {
        ranked: input.candidates.map((c) => ({
          profile_id: c.profile_id,
          score: c.score,
          rationale: c.rationale,
        })),
      };
    }

    const out = await invokeJson({
      ctx,
      vars: { brief: input.brief, candidates: input.candidates },
      outputSchema: bloggerMatcherOutputSchema,
      fallbackSystemPrompt: FALLBACK_SYSTEM,
      fallbackUserPromptTemplate: FALLBACK_USER,
    });

    // Constrain to the input id set; re-attach the deterministic score/rationale
    // for any candidate the model omitted so we never lose a shortlisted blogger.
    const allowed = new Map(input.candidates.map((c) => [c.profile_id, c]));
    const seen = new Set<string>();
    const ranked: BloggerMatcherOutput['ranked'] = [];
    for (const r of out.ranked) {
      const src = allowed.get(r.profile_id);
      if (!src || seen.has(r.profile_id)) continue;
      seen.add(r.profile_id);
      ranked.push({
        profile_id: r.profile_id,
        score: r.score,
        rationale: r.rationale || src.rationale,
      });
    }
    for (const c of input.candidates) {
      if (!seen.has(c.profile_id)) {
        ranked.push({ profile_id: c.profile_id, score: c.score, rationale: c.rationale });
      }
    }
    ranked.sort((a, b) => b.score - a.score);
    return { ranked };
  },
};
