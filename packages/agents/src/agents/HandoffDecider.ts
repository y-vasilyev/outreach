import { z } from 'zod';

import { CampaignAjtbdZ } from '@nosquare/shared/schemas';

import type { Agent } from '../types.js';
import { invokeJson, readParams } from './_runtime.js';
import { ConfidenceCoerced, HandoffActionCoerced, UrgencyCoerced } from './_coerce.js';

import { INTENTS } from './IntentClassifier.js';

export const handoffDeciderInputSchema = z.object({
  conversation: z.object({
    // The full set of conversation modes lives in shared/conversation.ts.
    // Keep this enum in sync — semi_auto added with chat-autonomous-modes.
    mode: z.enum(['auto', 'semi_auto', 'assisted', 'manual']),
    summary: z.string().optional(),
    last_inbound: z.string().optional(),
    history_tail: z.array(z.string()).default([]),
  }),
  intent: z.object({
    intent: z.enum(INTENTS),
    // Defensive — caller usually passes a clean number, but if it ever
    // forwards an LLM output we want the same coercion.
    confidence: ConfidenceCoerced,
  }),
  /**
   * Optional AJTBD framing — handoff_decider uses non_goals and
   * desired_outcome to decide if the contact has shifted into a
   * non-goal (e.g. asks for ad placement during CustDev) and the
   * pipeline should escalate to operator_now even when the intent
   * isn't on the hard-rule list.
   */
  ajtbd: CampaignAjtbdZ.optional(),
  ai_recent_confidence: z.array(ConfidenceCoerced).default([]),
  red_flags_total: z.number().int().nonnegative().default(0),
});

export const handoffDeciderOutputSchema = z.object({
  // Coerce both fields — the LLM regularly invents action words
  // (`continue_dialog`, `escalate`, …) and urgency labels (`urgent`,
  // `medium`, Russian variants). Tolerant mappers translate the obvious
  // synonyms; truly unknown values still fall through to a Zod error.
  action: HandoffActionCoerced,
  reason: z.string(),
  urgency: UrgencyCoerced,
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
AJTBD кампании: {{ajtbd}}
Желаемый исход кампании: {{desired_outcome}}
Anti-цели (non_goals — если собеседник тянет туда, эскалируй): {{non_goals}}
Свежие confidence ИИ: {{ai_recent_confidence}}
Red flags total: {{red_flags_total}}

Верни JSON.`;

export const handoffDecider: Agent<HandoffDeciderInput, HandoffDeciderOutput> = {
  name: 'handoff_decider',
  description: 'Решает: ИИ продолжает / только подсказки / оператор.',
  inputSchema: handoffDeciderInputSchema,
  outputSchema: handoffDeciderOutputSchema,
  variables: ['conversation', 'intent', 'ajtbd', 'ai_recent_confidence', 'red_flags_total'],
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
        ajtbd: input.ajtbd ?? null,
        non_goals: input.ajtbd?.non_goals ?? [],
        desired_outcome: input.ajtbd?.desired_outcome ?? '',
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
