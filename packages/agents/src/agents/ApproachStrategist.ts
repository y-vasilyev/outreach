import { z } from 'zod';

import type { Agent } from '../types.js';
import { invokeJson } from './_runtime.js';

export const approachStrategistInputSchema = z.object({
  channel_analysis: z.record(z.unknown()),
  contact: z.record(z.unknown()),
  campaign: z.object({
    goal_text: z.string(),
    value_prop: z.string(),
    examples: z.array(z.string()).optional(),
  }),
});

export const approachStrategistOutputSchema = z.object({
  approach: z.enum([
    'industry_fit',
    'audience_fit',
    'recent_post_hook',
    'peer',
    'compliment_then_ask',
  ]),
  hook: z.string(),
  why_them: z.string(),
  tone: z.enum(['formal', 'casual', 'peer']),
  do_avoid: z.array(z.string()).default([]),
});

export type ApproachStrategistInput = z.infer<typeof approachStrategistInputSchema>;
export type ApproachStrategistOutput = z.infer<typeof approachStrategistOutputSchema>;

const FALLBACK_SYSTEM = `Ты выбираешь угол захода для CustDev-приглашения автору канала. Цель — короткое исследовательское интервью по продукту. НЕ продажа, НЕ реклама. Выбери подход (industry_fit / audience_fit / recent_post_hook / peer / compliment_then_ask), сформулируй конкретную зацепку из тематики канала, объясни почему именно их, выбери тон и список того, чего избегать.`;

const FALLBACK_USER = `Анализ канала: {{channel_analysis}}
Контакт: {{contact}}
Кампания:
- цель: {{goal_text}}
- что предлагаем: {{value_prop}}
- примеры: {{examples}}

Верни JSON: { approach, hook, why_them, tone, do_avoid[] }.`;

export const approachStrategist: Agent<
  ApproachStrategistInput,
  ApproachStrategistOutput
> = {
  name: 'approach_strategist',
  description: 'Выбирает угол захода для CustDev-приглашения.',
  inputSchema: approachStrategistInputSchema,
  outputSchema: approachStrategistOutputSchema,
  variables: ['channel_analysis', 'contact', 'campaign', 'goal_text', 'value_prop', 'examples'],
  defaultModel: 'yandexgpt',
  defaultParams: { temperature: 0.3, max_tokens: 500 },
  async run(input, ctx) {
    return invokeJson({
      ctx,
      vars: {
        channel_analysis: input.channel_analysis,
        contact: input.contact,
        campaign: input.campaign,
        goal_text: input.campaign.goal_text,
        value_prop: input.campaign.value_prop,
        examples: input.campaign.examples ?? [],
      },
      outputSchema: approachStrategistOutputSchema,
      fallbackSystemPrompt: FALLBACK_SYSTEM,
      fallbackUserPromptTemplate: FALLBACK_USER,
    });
  },
};
