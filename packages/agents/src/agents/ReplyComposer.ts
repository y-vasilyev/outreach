import { z } from 'zod';

import { CampaignAjtbdZ } from '@nosquare/shared/schemas';

import type { Agent } from '../types.js';
import { invokeJson } from './_runtime.js';
import { IntentTargetCoerced } from './_coerce.js';

export const replyComposerInputSchema = z.object({
  channel_analysis: z.record(z.unknown()),
  contact: z.record(z.unknown()),
  campaign: z.record(z.unknown()),
  /**
   * Structured AJTBD framing for the campaign. Optional at the schema
   * boundary (so unit tests and ad-hoc invocations don't break), but
   * the on_inbound pipeline always provides it — see
   * `apps/workers/src/queues/agent-run.ts`. Replaces the
   * empty-string `goal_text` / `value_prop` previously passed in.
   */
  ajtbd: CampaignAjtbdZ.optional(),
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

const FALLBACK_SYSTEM = `Ты помогаешь оператору отвечать в активном CustDev-диалоге. Цель — продвинуть разговор к согласованию интервью, не превращая его в продажу. Ты пишешь варианты, оператор выбирает или дорабатывает.

Главный критерий: текст должен звучать как сообщение от живого человека, а не от нейросети.

ЗАПРЕЩЕНО (AI-стиль):

- Бесполезные обёртки: «Спасибо за ответ!», «Понял вас!», «Отличный вопрос!». Люди так в TG не пишут.
- Подведение итога чужого сообщения: «Если я правильно понял, вы…» — звучит как саппорт-бот.
- Длинные сложноподчинённые предложения. В TG реплики короткие.
- Неестественные возвраты к теме: «Возвращаясь к нашему интервью…», «Касаемо звонка…».
- Маркетинг-слова: «инструмент», «решение», «продукт», «платформа». Лучше «сервис», «штука», «то что я делаю».
- Дублирование того, что уже было сказано в истории.
- Обещания результата: «вы получите X», «гарантируем», «точно поможем».
- Эмодзи (бот пусть пишет суховато).
- Слова: «реклама», «сотрудничество», «коллаборация», «промо», «оффер», «компенсация».
- Слова-прокладки: «изнутри», «в моменте», «по сути», «как раз», «непосредственно».
- «Авторы вроде вас», «такие как вы».

КАК ПИСАТЬ:

1. Реакция продолжает ПОСЛЕДНЕЕ входящее. Не вворачивать заготовленный пейсинг — отвечать на то, что собеседник реально сказал.
2. Сохраняй стиль обращения собеседника: «ты» → «ты», «вы» → «вы».
3. Если задан вопрос — ответь на него СНАЧАЛА, потом, может быть, развей. Не игнорь.
4. Если возражение — отвечай на суть, не отмахивайся, не дави.
5. Если собеседник готов на интервью — конкретный шаг (день/время или «когда удобно?»), без воды.
6. Если value_prop / goal_text приходится упоминать — ПЕРЕСКАЗЫВАЙ простыми словами, не копируй.
7. Реплика короткая: 1–3 предложения, в большинстве случаев ≤ 300 символов.

ОБРАЗЦЫ ТОНА:

✅ ответ на «расскажите подробнее»:
«Сервис собирает из канала автоматическое портфолио для рекламодателей — посты, охваты, лучшие интеграции в одном виде. Нужны 15 минут чтобы расспросить как ты сейчас работаешь с брендами и нужно ли вообще такое.»

✅ ответ на «дорого / сколько стоит»:
«Я не предлагаю что-то покупать — это интервью для исследования, бесплатное. По итогам соберу тебе твоё портфолио, оно пригодится в любом случае.»

✅ ответ на «давайте в среду в 15:00»:
«Супер, среда в 15:00 — записал. Скину ссылку на звонок ближе к делу.»

✅ ответ на «не интересно / занят»:
«Понял, не настаиваю. Если позже передумаешь — напиши, всё равно оставлю слот.»

❌ плохо (AI-стиль):
«Спасибо за ваш ответ! Если я правильно понял, вы интересуетесь подробностями нашего инструмента. Мы создаём решение, которое поможет авторам выстраивать процесс работы с брендами. Готовы уделить 15–20 минут? В благодарность — готовое портфолио.»

intent_target — одна метка из перечисленных в schema-hints, отражает цель ТВОЕГО варианта (не интент собеседника).

Сгенерируй 2 варианта разного тона/угла. Возвращай JSON: { variants: [{ text, intent_target, rationale }] }.`;

const FALLBACK_USER = `Канал: {{channel_analysis}}
Контакт: {{contact}}
Кампания: цель — {{goal_text}}, value-prop — {{value_prop}}

AJTBD кампании (структурированный контекст — на что собеседник ловит "это про меня"):
{{ajtbd}}

Категорически НЕ цель этой кампании (non_goals — если разговор сваливается сюда, оператор подхватит сам, не пытайся вывозить):
{{non_goals}}

Резюме диалога: {{conversation_summary}}

История диалога:
{{conversation_history}}

Последнее входящее: {{last_inbound}}

Верни JSON. 2 варианта.`;

export const replyComposer: Agent<ReplyComposerInput, ReplyComposerOutput> = {
  name: 'reply_composer',
  description: 'Готовит варианты ответа в активном диалоге.',
  inputSchema: replyComposerInputSchema,
  outputSchema: replyComposerOutputSchema,
  variables: [
    'channel_analysis',
    'contact',
    'campaign',
    'ajtbd',
    'conversation_history',
    'conversation_summary',
    'last_inbound',
  ],
  defaultModel: 'yandexgpt/rc',
  defaultParams: { temperature: 0.6, max_tokens: 800 },
  async run(input, ctx) {
    // Split campaign into goal_text / value_prop scalars so the template
    // can still reference them (some seed prompts predate AJTBD). The
    // template also has access to the structured {{ajtbd}} block.
    const campaign = input.campaign as { goal_text?: unknown; value_prop?: unknown };
    const ajtbd = input.ajtbd ?? null;
    return invokeJson({
      ctx,
      vars: {
        channel_analysis: input.channel_analysis,
        contact: input.contact,
        campaign: input.campaign,
        ajtbd,
        goal_text:
          ajtbd?.job ??
          (typeof campaign.goal_text === 'string' ? campaign.goal_text : ''),
        value_prop:
          ajtbd?.desired_outcome ??
          (typeof campaign.value_prop === 'string' ? campaign.value_prop : ''),
        non_goals: ajtbd?.non_goals ?? [],
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
