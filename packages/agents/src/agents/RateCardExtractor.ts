import { z } from 'zod';
import { ProfileExtractionOutputZ } from '@nosquare/shared';

import type { Agent } from '../types.js';
import { invokeJson } from './_runtime.js';

/**
 * RateCardExtractor — `rate_card_extractor`
 *
 * Reads a blogger's free-text reply(s) (and an optional structured snapshot)
 * and emits per-format rate data points as `ProfileDataPointDraft`s
 * (agency-sourcing-matching M5, task 5.1). Each draft:
 *   - `field`  — `rate.<format>` (e.g. `rate.post`, `rate.story`, `rate.reels`)
 *   - `value`  — numeric price
 *   - `unit`   — currency (RUB/USD/…)
 *   - `confidence` — 0..1
 *   - `rawSnippet` — VERBATIM source fragment the price came from
 *
 * MUST (spec):
 *   - preserve the verbatim source text in `rawSnippet` (provenance + audit);
 *   - emit low-confidence/ambiguous facts (with a low confidence) rather than
 *     dropping them, so an operator can review.
 *
 * Runs via AgentRunner (writes `agent_run`). The worker persists the drafts as
 * `profile_data_point` rows linked to the channel's BloggerProfile.
 */

export const rateCardExtractorInputSchema = z.object({
  /** The blogger's free-text reply(s), most recent last, joined or as lines. */
  replies: z.array(z.string()).default([]),
  /** Convenience single-string form (latest reply); used when replies empty. */
  last_inbound: z.string().default(''),
  /** Optional structured snapshot (e.g. a parsed media-kit blob). */
  structured_snapshot: z.record(z.unknown()).optional(),
  /** Light context so the model can disambiguate currency/format. */
  channel_title: z.string().default(''),
  language: z.string().default('ru'),
});

export const rateCardExtractorOutputSchema = ProfileExtractionOutputZ;

export type RateCardExtractorInput = z.infer<typeof rateCardExtractorInputSchema>;
export type RateCardExtractorOutput = z.infer<typeof rateCardExtractorOutputSchema>;

const FALLBACK_SYSTEM = `Ты извлекаешь ПРАЙС за рекламные форматы из ответов блогера. На вход — свободный текст (и иногда структурированный снимок). Твоя задача — превратить упомянутые цены в структурированные точки данных.

ФОРМАТ ВЫВОДА: массив data_points. Каждая точка:
- field — "rate.<формат>" латиницей: rate.post (пост), rate.story (сторис), rate.reels (reels/клип), rate.video (видео/ролик), rate.integration (интеграция), rate.repost (репост/закреп). Если формат непонятен — rate.other.
- value — ЧИСЛО (цена), без валюты и пробелов. "8 000" → 8000, "15к"/"15k" → 15000, "1.2к" → 1200.
- unit — валюта: "RUB" (руб/₽/р по умолчанию для русского), "USD" ($), "EUR" (€).
- confidence — 0..1. Явная цена за явный формат («пост 15000») → 0.9+. Цена есть, но формат неясен → 0.4–0.6. Двусмысленно (число может быть не ценой, а охватом/числом подписчиков) → ≤ 0.3, НО ВСЁ РАВНО ВЕРНИ ТОЧКУ (оператор проверит). Никогда не выбрасывай неоднозначное молча.
- rawSnippet — ДОСЛОВНЫЙ фрагмент исходного текста, из которого взята цена (5–15 слов). Обязательно verbatim, не перефразируй.

ПРАВИЛА:
- Не выдумывай цены, которых нет в тексте.
- Если в тексте несколько форматов с ценами — верни по точке на каждый.
- Если цена «пакетом» (пост+сторис за общую сумму) — верни одну точку rate.other с rawSnippet и confidence ≤ 0.5, опиши в note.
- Если прайса нет вообще — верни пустой data_points и заполни note.

Возвращай только JSON: { data_points: [{ field, value, unit?, confidence, rawSnippet }], note? }.`;

const FALLBACK_USER = `Канал: {{channel_title}} (язык: {{language}})

Ответы блогера (самый свежий — последний):
{{replies_text}}

Структурированный снимок (если есть):
{{structured_snapshot}}

Верни JSON со всеми упомянутыми ценами как data_points. Сохрани verbatim rawSnippet.`;

export const rateCardExtractor: Agent<RateCardExtractorInput, RateCardExtractorOutput> = {
  name: 'rate_card_extractor',
  description:
    'Извлекает из ответов блогера прайс по форматам как profile_data_point (rate.<format>) с confidence и verbatim rawSnippet.',
  inputSchema: rateCardExtractorInputSchema,
  outputSchema: rateCardExtractorOutputSchema,
  variables: ['channel_title', 'language', 'replies_text', 'structured_snapshot'],
  defaultModel: 'google/gemini-3-flash-preview',
  defaultParams: { temperature: 0.1, max_tokens: 900 },
  async run(input, ctx) {
    const replies = input.replies.length > 0
      ? input.replies
      : input.last_inbound
        ? [input.last_inbound]
        : [];
    const repliesText = replies.map((r, i) => `${i + 1}. ${r}`).join('\n');

    const out = await invokeJson({
      ctx,
      vars: {
        channel_title: input.channel_title,
        language: input.language,
        replies_text: repliesText || '(пусто)',
        structured_snapshot: input.structured_snapshot ?? {},
      },
      outputSchema: rateCardExtractorOutputSchema,
      fallbackSystemPrompt: FALLBACK_SYSTEM,
      fallbackUserPromptTemplate: FALLBACK_USER,
    });

    // Deterministic guard: keep ALL points (incl. low-confidence). We only
    // backfill rawSnippet from the source when the model forgot it, so we
    // never lose provenance — never threshold-drop here (the spec requires
    // ambiguous points reach the operator).
    const sourceText = replies.join('\n');
    const data_points = out.data_points.map((dp) => ({
      ...dp,
      field: dp.field.startsWith('rate.') ? dp.field : `rate.${dp.field}`,
      rawSnippet: dp.rawSnippet && dp.rawSnippet.trim().length > 0 ? dp.rawSnippet : sourceText,
    }));

    return { data_points, ...(out.note !== undefined ? { note: out.note } : {}) };
  },
};
