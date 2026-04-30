import { z } from 'zod';

import type { Agent } from '../types.js';
import { invokeJson, readParams } from './_runtime.js';

import { INTENTS } from './IntentClassifier.js';

export const handoffDeciderInputSchema = z.object({
  conversation: z.object({
    mode: z.enum(['auto', 'assisted', 'manual']),
    summary: z.string().optional(),
    last_inbound: z.string().optional(),
    history_tail: z.array(z.string()).default([]),
  }),
  intent: z.object({
    intent: z.enum(INTENTS),
    confidence: z.number().min(0).max(1),
  }),
  ai_recent_confidence: z.array(z.number().min(0).max(1)).default([]),
  red_flags_total: z.number().int().nonnegative().default(0),
});

export const handoffDeciderOutputSchema = z.object({
  action: z.enum(['ai_continue', 'ai_suggest_only', 'operator_now']),
  reason: z.string(),
  urgency: z.enum(['low', 'normal', 'high']),
});

export type HandoffDeciderInput = z.infer<typeof handoffDeciderInputSchema>;
export type HandoffDeciderOutput = z.infer<typeof handoffDeciderOutputSchema>;

const OPERATOR_NOW_INTENTS = new Set([
  'hostile',
  'spam_complaint',
  'request_human',
  'wants_payment_for_ads',
  'wants_to_schedule',
]);

const FALLBACK_SYSTEM = `Ты решаешь, продолжать ли ИИ диалог или передать оператору. Возможные действия: ai_continue, ai_suggest_only, operator_now. Учитывай интент, уверенность, тон, историю. Возвращай JSON: { action, reason, urgency }.`;

const FALLBACK_USER = `Диалог: {{conversation}}
Интент: {{intent}}
Свежие confidence ИИ: {{ai_recent_confidence}}
Red flags total: {{red_flags_total}}

Верни JSON.`;

export const handoffDecider: Agent<HandoffDeciderInput, HandoffDeciderOutput> = {
  name: 'handoff_decider',
  description: 'Решает: ИИ продолжает / только подсказки / оператор.',
  inputSchema: handoffDeciderInputSchema,
  outputSchema: handoffDeciderOutputSchema,
  variables: ['conversation', 'intent', 'ai_recent_confidence', 'red_flags_total'],
  defaultModel: 'yandexgpt-lite',
  defaultParams: {
    temperature: 0,
    max_tokens: 200,
    confidence_threshold: 0.5,
    escalation_keywords: [],
  },
  async run(input, ctx) {
    const params = readParams(ctx.config.params);
    const threshold =
      typeof params.confidence_threshold === 'number' ? params.confidence_threshold : 0.5;
    const escalationKw = readStringArray(params.escalation_keywords, []);

    // Rule 1: intents that always escalate.
    if (OPERATOR_NOW_INTENTS.has(input.intent.intent)) {
      return {
        action: 'operator_now',
        reason: `intent_${input.intent.intent}`,
        urgency: 'high',
      };
    }

    // Rule 2: escalation keywords in last_inbound.
    const lastInbound = input.conversation.last_inbound?.toLowerCase() ?? '';
    for (const kw of escalationKw) {
      if (kw && lastInbound.includes(kw.toLowerCase())) {
        return {
          action: 'operator_now',
          reason: `escalation_keyword:${kw}`,
          urgency: 'high',
        };
      }
    }

    // Rule 3: 2 consecutive low-confidence AI runs → demote to suggestions.
    const recent = input.ai_recent_confidence;
    if (recent.length >= 2) {
      const last = recent[recent.length - 1];
      const prev = recent[recent.length - 2];
      if (
        typeof last === 'number' &&
        typeof prev === 'number' &&
        last < threshold &&
        prev < threshold
      ) {
        return {
          action: 'ai_suggest_only',
          reason: 'two_low_confidence_in_a_row',
          urgency: 'normal',
        };
      }
    }

    // Otherwise — ask the LLM.
    return invokeJson({
      ctx,
      vars: {
        conversation: input.conversation,
        intent: input.intent,
        ai_recent_confidence: input.ai_recent_confidence,
        red_flags_total: input.red_flags_total,
      },
      outputSchema: handoffDeciderOutputSchema,
      fallbackSystemPrompt: FALLBACK_SYSTEM,
      fallbackUserPromptTemplate: FALLBACK_USER,
    });
  },
};

function readStringArray(v: unknown, fallback: string[]): string[] {
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  return fallback;
}
