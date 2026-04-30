import { z } from 'zod';

import type { Agent } from '../types.js';
import { invokeJson } from './_runtime.js';

export const conversationSummarizerInputSchema = z.object({
  history: z.array(
    z.object({
      direction: z.enum(['in', 'out']),
      sender: z.string(),
      text: z.string(),
      at: z.string().optional(),
    }),
  ),
  previous_summary: z.string().optional(),
});

export const conversationSummarizerOutputSchema = z.object({
  summary: z.string(),
  key_facts: z.array(z.string()).default([]),
  open_questions: z.array(z.string()).default([]),
});

export type ConversationSummarizerInput = z.infer<
  typeof conversationSummarizerInputSchema
>;
export type ConversationSummarizerOutput = z.infer<
  typeof conversationSummarizerOutputSchema
>;

const FALLBACK_SYSTEM = `Ты сжимаешь историю CustDev-диалога. Сохрани: текущий статус (заинтересован / возражает / отказался), ключевые факты, открытые вопросы. Без воды. Возвращай JSON: { summary, key_facts[], open_questions[] }.`;

const FALLBACK_USER = `Предыдущее резюме: {{previous_summary}}

История:
{{history}}

Верни JSON.`;

export const conversationSummarizer: Agent<
  ConversationSummarizerInput,
  ConversationSummarizerOutput
> = {
  name: 'conversation_summarizer',
  description: 'Сжимает историю диалога каждые N сообщений.',
  inputSchema: conversationSummarizerInputSchema,
  outputSchema: conversationSummarizerOutputSchema,
  variables: ['history', 'previous_summary'],
  defaultModel: 'yandexgpt',
  defaultParams: { temperature: 0.1, max_tokens: 600 },
  async run(input, ctx) {
    return invokeJson({
      ctx,
      vars: {
        history: input.history
          .map((m) => `${m.direction === 'in' ? '<' : '>'} ${m.sender}: ${m.text}`)
          .join('\n'),
        previous_summary: input.previous_summary ?? '',
      },
      outputSchema: conversationSummarizerOutputSchema,
      fallbackSystemPrompt: FALLBACK_SYSTEM,
      fallbackUserPromptTemplate: FALLBACK_USER,
    });
  },
};
