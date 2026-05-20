import { z } from 'zod';

import type { Agent } from '../types.js';
import { invokeJson } from './_runtime.js';
import { ConfidenceCoerced } from './_coerce.js';

export const INTENTS = [
  'interested',
  'needs_more_info',
  'asks_about_product',
  'objection_busy',
  'objection_irrelevant',
  'objection_compensation',
  'wants_payment_for_ads',
  'wants_to_schedule',
  // Agency-sourcing commercial intents (agency-sourcing-matching M4). These
  // are listed in the agency type's autonomyPolicy.forceHandoffIntents so the
  // worker escalates them to the operator — a human confirms commercial terms
  // before any price is agreed or a quote goes out. They are harmless to
  // CustDev (whose policy lists neither), so adding them is additive.
  'discusses_price',
  'sends_quote',
  'declined',
  'hostile',
  'spam_complaint',
  'request_human',
  'silence_likely',
] as const;

export const intentClassifierInputSchema = z.object({
  last_inbound: z.string(),
  history_tail: z.array(z.string()).default([]),
});

export const intentClassifierOutputSchema = z.object({
  intent: z.enum(INTENTS),
  // Coerce qualitative confidence ("high"/"medium"/"низк") + 0..100 percent.
  confidence: ConfidenceCoerced,
  signals: z.array(z.string()).default([]),
});

export type IntentClassifierInput = z.infer<typeof intentClassifierInputSchema>;
export type IntentClassifierOutput = z.infer<typeof intentClassifierOutputSchema>;

const FALLBACK_SYSTEM = `Ты классифицируешь входящее сообщение в диалоге аутрича. Возможные интенты: ${INTENTS.join(', ')}.
- wants_payment_for_ads — собеседник принял нас за покупателя рекламы и называет/просит цену (важный сигнал для CustDev).
- discusses_price — собеседник обсуждает/называет цену или прайс под коммерческое размещение (агентский сценарий).
- sends_quote — собеседник прислал коммерческое предложение/смету/конкретные условия сделки.
Возвращай JSON: { intent, confidence, signals[] }.`;

const FALLBACK_USER = `Последнее входящее: {{last_inbound}}

Хвост истории:
{{history_tail}}

Верни JSON.`;

export const intentClassifier: Agent<
  IntentClassifierInput,
  IntentClassifierOutput
> = {
  name: 'intent_classifier',
  description: 'Классифицирует входящее под CustDev-сценарий.',
  inputSchema: intentClassifierInputSchema,
  outputSchema: intentClassifierOutputSchema,
  variables: ['last_inbound', 'history_tail'],
  defaultModel: 'yandexgpt-lite',
  defaultParams: { temperature: 0, max_tokens: 200 },
  async run(input, ctx) {
    return invokeJson({
      ctx,
      vars: {
        last_inbound: input.last_inbound,
        history_tail: input.history_tail.join('\n'),
      },
      outputSchema: intentClassifierOutputSchema,
      fallbackSystemPrompt: FALLBACK_SYSTEM,
      fallbackUserPromptTemplate: FALLBACK_USER,
    });
  },
};
