import { z } from 'zod';

import type { Agent } from '../types.js';
import { invokeJson } from './_runtime.js';
import { LengthCoerced, RiskScoreCoerced } from './_coerce.js';

export const openingComposerInputSchema = z.object({
  channel_analysis: z.record(z.unknown()),
  contact: z.record(z.unknown()),
  strategy: z.record(z.unknown()),
  campaign: z.object({
    goal_text: z.string(),
    value_prop: z.string(),
  }),
  examples: z.array(z.string()).optional(),
});

export const openingComposerOutputSchema = z.object({
  variants: z
    .array(
      z.object({
        text: z.string().max(600, 'opening text must be ≤600 chars'),
        rationale: z.string(),
        // Coerce raw character counts → bucket; 'short'/'medium'/'long' pass through.
        length: LengthCoerced,
        // Coerce 0..100 percentages → 0..1; clamp out-of-range numbers.
        risk_score: RiskScoreCoerced,
      }),
    )
    .min(1)
    .max(5),
});

export type OpeningComposerInput = z.infer<typeof openingComposerInputSchema>;
export type OpeningComposerOutput = z.infer<typeof openingComposerOutputSchema>;

const FALLBACK_SYSTEM = `Ты пишешь первое сообщение в личку незнакомому автору канала с приглашением на 20-минутное исследовательское интервью по продукту. Цель — НЕ продать, НЕ предложить рекламу, НЕ запитчить. Только узнать, готов ли он на короткое интервью.

Жёсткие правила:
- Не используй слова «реклама», «рекламная интеграция», «сотрудничество», «созвониться обсудить».
- Покажи, что прочитал канал. 1 конкретная деталь из тематики/постов.
- Назови продукт и роль интервью одним предложением.
- Чётко обозначь длительность (15–20 минут) и компенсацию из value-prop.
- Не давай ссылок без причины. Не используй эмодзи в начале.
- 2–4 предложения. Звучи как живой человек, не как бот.
- Если уверенность низкая — лучше короче и проще.

Сгенерируй 2–3 варианта (короткий, средний, длинный). Длина каждого варианта ≤ 600 символов. Возвращай JSON: { variants: [{ text, rationale, length, risk_score }] }.`;

const FALLBACK_USER = `Канал: {{channel_analysis}}
Контакт: {{contact}}
Подход: {{strategy}}
Кампания:
- цель: {{goal_text}}
- что предлагаем: {{value_prop}}
Примеры удачных сообщений: {{examples}}

Верни JSON.`;

export const openingComposer: Agent<OpeningComposerInput, OpeningComposerOutput> = {
  name: 'opening_composer',
  description: 'Пишет 2–3 варианта первого CustDev-сообщения.',
  inputSchema: openingComposerInputSchema,
  outputSchema: openingComposerOutputSchema,
  variables: [
    'channel_analysis',
    'contact',
    'strategy',
    'campaign',
    'goal_text',
    'value_prop',
    'examples',
  ],
  defaultModel: 'yandexgpt/rc',
  defaultParams: { temperature: 0.7, max_tokens: 1000 },
  async run(input, ctx) {
    return invokeJson({
      ctx,
      vars: {
        channel_analysis: input.channel_analysis,
        contact: input.contact,
        strategy: input.strategy,
        campaign: input.campaign,
        goal_text: input.campaign.goal_text,
        value_prop: input.campaign.value_prop,
        examples: input.examples ?? [],
      },
      outputSchema: openingComposerOutputSchema,
      fallbackSystemPrompt: FALLBACK_SYSTEM,
      fallbackUserPromptTemplate: FALLBACK_USER,
    });
  },
};
