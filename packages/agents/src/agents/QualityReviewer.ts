import { z } from 'zod';

import type { Agent } from '../types.js';
import { invokeJson } from './_runtime.js';

const score1to5 = z.number().int().min(1).max(5);

export const qualityReviewerInputSchema = z.object({
  draft: z.string(),
  conversation_history: z
    .array(
      z.object({
        direction: z.enum(['in', 'out']),
        sender: z.string(),
        text: z.string(),
      }),
    )
    .default([]),
  channel_analysis: z.record(z.unknown()).optional(),
  contact: z.record(z.unknown()).optional(),
});

export const qualityReviewerOutputSchema = z.object({
  scores: z.object({
    relevance: score1to5,
    tone: score1to5,
    grammar: score1to5,
    personalization: score1to5,
    on_brief: score1to5,
  }),
  notes: z.string().default(''),
});

export type QualityReviewerInput = z.infer<typeof qualityReviewerInputSchema>;
export type QualityReviewerOutput = z.infer<typeof qualityReviewerOutputSchema>;

const FALLBACK_SYSTEM = `Ты — оффлайн-рецензент CustDev-сообщений. Оцени черновик по шкале 1..5 по: relevance, tone, grammar, personalization, on_brief (соответствие CustDev-цели — НЕ продажа). Возвращай JSON: { scores: {...}, notes }.`;

const FALLBACK_USER = `Черновик:
{{draft}}

История: {{conversation_history}}
Канал: {{channel_analysis}}
Контакт: {{contact}}

Верни JSON.`;

export const qualityReviewer: Agent<QualityReviewerInput, QualityReviewerOutput> = {
  name: 'quality_reviewer',
  description: 'Семплирует исходящие и оценивает их качество (offline).',
  inputSchema: qualityReviewerInputSchema,
  outputSchema: qualityReviewerOutputSchema,
  variables: ['draft', 'conversation_history', 'channel_analysis', 'contact'],
  defaultModel: 'claude-sonnet',
  defaultParams: { temperature: 0, max_tokens: 400 },
  async run(input, ctx) {
    return invokeJson({
      ctx,
      vars: {
        draft: input.draft,
        conversation_history: input.conversation_history,
        channel_analysis: input.channel_analysis ?? {},
        contact: input.contact ?? {},
      },
      outputSchema: qualityReviewerOutputSchema,
      fallbackSystemPrompt: FALLBACK_SYSTEM,
      fallbackUserPromptTemplate: FALLBACK_USER,
    });
  },
};
