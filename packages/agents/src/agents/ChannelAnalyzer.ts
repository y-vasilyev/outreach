import { z } from 'zod';

import type { Agent } from '../types.js';
import { invokeJson } from './_runtime.js';

export const channelAnalyzerInputSchema = z.object({
  platform: z.enum(['telegram', 'instagram', 'youtube']),
  title: z.string(),
  description: z.string(),
  links: z.array(z.string()).default([]),
  followers: z.number().int().nonnegative().optional(),
  language_hint: z.string().optional(),
  recent_posts: z
    .array(
      z.object({
        date: z.string().optional(),
        text: z.string().default(''),
        urls: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

export const channelAnalyzerOutputSchema = z.object({
  language: z.enum(['ru', 'en', 'other']),
  topic: z.string(),
  audience: z.string(),
  format: z.string(),
  tone: z.enum(['formal', 'casual', 'edgy', 'neutral']),
  owner_signals: z.object({
    is_personal_brand: z.boolean(),
    owner_hint: z.string().optional(),
  }),
  red_flags: z.array(z.string()).default([]),
});

export type ChannelAnalyzerInput = z.infer<typeof channelAnalyzerInputSchema>;
export type ChannelAnalyzerOutput = z.infer<typeof channelAnalyzerOutputSchema>;

const FALLBACK_SYSTEM = `Ты анализируешь публичный канал автора в соцсети. По названию, описанию, ссылкам и нескольким последним постам кратко описываешь его в структурированном виде. Не выдумывай факты. Если данных мало — честно отмечай низкие уровни уверенности и оставляй поля пустыми. Возвращай только JSON по схеме.`;

const FALLBACK_USER = `Платформа: {{platform}}
Название: {{title}}
Описание: {{description}}
Ссылки: {{links}}
Подписчики: {{followers}}
Подсказка языка: {{language_hint}}

Последние посты:
{{recent_posts}}

Верни JSON со следующими полями: language, topic, audience, format, tone, owner_signals (is_personal_brand, owner_hint?), red_flags[].`;

export const channelAnalyzer: Agent<ChannelAnalyzerInput, ChannelAnalyzerOutput> = {
  name: 'channel_analyzer',
  description: 'Анализирует канал: тематика, аудитория, тон, владелец, красные флаги.',
  inputSchema: channelAnalyzerInputSchema,
  outputSchema: channelAnalyzerOutputSchema,
  variables: ['platform', 'title', 'description', 'links', 'followers', 'language_hint', 'recent_posts'],
  defaultModel: 'yandexgpt',
  defaultParams: { temperature: 0.2, max_tokens: 600 },
  async run(input, ctx) {
    return invokeJson({
      ctx,
      vars: {
        ...input,
        followers: input.followers ?? '',
        language_hint: input.language_hint ?? '',
        recent_posts: input.recent_posts
          .map((p) => `- ${p.date ?? ''}: ${p.text}`)
          .join('\n'),
        links: input.links.join(', '),
      },
      outputSchema: channelAnalyzerOutputSchema,
      fallbackSystemPrompt: FALLBACK_SYSTEM,
      fallbackUserPromptTemplate: FALLBACK_USER,
    });
  },
};
