import { z } from 'zod';

import type { Agent } from '../types.js';
import { invokeJson } from './_runtime.js';
import { IntentTargetCoerced } from './_coerce.js';

export const replyComposerInputSchema = z.object({
  channel_analysis: z.record(z.unknown()),
  contact: z.record(z.unknown()),
  campaign: z.record(z.unknown()),
  conversation_history: z
    .array(
      z.object({
        direction: z.enum(['in', 'out']),
        sender: z.string(),
        text: z.string(),
        at: z.string().optional(),
      }),
    )
    .default([]),
  conversation_summary: z.string().optional(),
  last_inbound: z.object({
    text: z.string(),
    intent: z.string(),
    sentiment: z.string().optional(),
  }),
});

export const replyComposerOutputSchema = z.object({
  variants: z
    .array(
      z.object({
        text: z.string().max(600),
        // Coerce — the LLM regularly invents its own verbs
        // (`clarify_or_close`, `schedule_interview`, …). Tolerant mapper
        // translates obvious synonyms; unknown values still fall through
        // to a Zod error so we don't silently mis-tag the suggestion.
        intent_target: IntentTargetCoerced,
        rationale: z.string(),
      }),
    )
    .min(1)
    .max(5),
});

export type ReplyComposerInput = z.infer<typeof replyComposerInputSchema>;
export type ReplyComposerOutput = z.infer<typeof replyComposerOutputSchema>;

const FALLBACK_SYSTEM = `Ты пишешь подсказки оператору в активном CustDev-диалоге. Цель не продать, а провести 15–20 минут интервью по продукту. Учитывай историю и последнее входящее. Не давай обещаний результата, не используй слово «реклама», не давай ссылок без причины. 2 варианта, каждый ≤ 600 символов. Возвращай JSON: { variants: [{ text, intent_target, rationale }] }.`;

const FALLBACK_USER = `Анализ канала: {{channel_analysis}}
Контакт: {{contact}}
Кампания: {{campaign}}
Резюме диалога: {{conversation_summary}}
История: {{conversation_history}}
Последнее входящее: {{last_inbound}}

Верни JSON.`;

export const replyComposer: Agent<ReplyComposerInput, ReplyComposerOutput> = {
  name: 'reply_composer',
  description: 'Готовит варианты ответа в активном диалоге.',
  inputSchema: replyComposerInputSchema,
  outputSchema: replyComposerOutputSchema,
  variables: [
    'channel_analysis',
    'contact',
    'campaign',
    'conversation_history',
    'conversation_summary',
    'last_inbound',
  ],
  defaultModel: 'yandexgpt/rc',
  defaultParams: { temperature: 0.6, max_tokens: 800 },
  async run(input, ctx) {
    return invokeJson({
      ctx,
      vars: {
        channel_analysis: input.channel_analysis,
        contact: input.contact,
        campaign: input.campaign,
        conversation_history: input.conversation_history,
        conversation_summary: input.conversation_summary ?? '',
        last_inbound: input.last_inbound,
      },
      outputSchema: replyComposerOutputSchema,
      fallbackSystemPrompt: FALLBACK_SYSTEM,
      fallbackUserPromptTemplate: FALLBACK_USER,
    });
  },
};
