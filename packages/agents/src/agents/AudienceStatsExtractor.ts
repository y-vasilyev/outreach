import { z } from 'zod';
import { ProfileExtractionOutputZ } from '@nosquare/shared';

import type { Agent } from '../types.js';
import { invokeJson } from './_runtime.js';

/**
 * AudienceStatsExtractor — `audience_stats_extractor`
 *
 * Reads a blogger's free-text reply(s) (and an optional structured snapshot)
 * and emits reach / views / audience-demographics / geo data points as
 * `ProfileDataPointDraft`s (agency-sourcing-matching M5, task 5.1).
 *
 * Field convention (consumed by the deterministic roll-up):
 *   - `reach.<format>` / `reach`  — numeric reach (value = number)
 *   - `views.avg`                 — average views (number)
 *   - `audience.geo`              — geo distribution (record label→share/count)
 *   - `audience.age`              — age distribution
 *   - `audience.gender`           — gender distribution
 *
 * MUST (spec):
 *   - preserve the verbatim source text in `rawSnippet`;
 *   - emit low-confidence/ambiguous facts (e.g. unsure whether a number is
 *     reach or subscriber count) rather than dropping them, so an operator can
 *     review. The classic ambiguity ("охваты сторис ~12к, пост 25к") yields
 *     `reach.story` + `reach.post` points each with the verbatim snippet.
 *
 * Runs via AgentRunner (writes `agent_run`).
 */

export const audienceStatsExtractorInputSchema = z.object({
  replies: z.array(z.string()).default([]),
  last_inbound: z.string().default(''),
  structured_snapshot: z.record(z.unknown()).optional(),
  channel_title: z.string().default(''),
  language: z.string().default('ru'),
});

export const audienceStatsExtractorOutputSchema = ProfileExtractionOutputZ;

export type AudienceStatsExtractorInput = z.infer<typeof audienceStatsExtractorInputSchema>;
export type AudienceStatsExtractorOutput = z.infer<typeof audienceStatsExtractorOutputSchema>;

const FALLBACK_SYSTEM = `Ты извлекаешь СТАТИСТИКУ АУДИТОРИИ блогера из его ответов: охваты, просмотры, демографию (пол/возраст), географию. На вход — свободный текст (и иногда структурированный снимок).

ФОРМАТ ВЫВОДА: массив data_points. Каждая точка:
- field — одно из:
  · "reach.<формат>" — охват по формату: reach.story (сторис), reach.post (пост), reach.reels. Просто "reach" если формат не указан.
  · "views.avg" — средние просмотры поста/видео.
  · "audience.geo" — география. value = объект { "Россия": 0.7, "Казахстан": 0.1, ... } (доли 0..1) или абсолютные числа.
  · "audience.age" — возраст. value = объект { "18-24": 0.3, "25-34": 0.5, ... }.
  · "audience.gender" — пол. value = объект { "female": 0.6, "male": 0.4 }.
- value — для reach/views ЧИСЛО ("12к"/"12k" → 12000, "1,2 млн" → 1200000). Для audience.* — ОБЪЕКТ label→доля/число.
- unit — опционально ("просмотры", "охват", "%"). Для долей можно опустить.
- confidence — 0..1. Явно («охваты сторис 12000») → 0.9. Если НЕЯСНО, что это за число — охват или число подписчиков — ВСЁ РАВНО верни точку с confidence ≤ 0.3 (оператор разберётся). Никогда не выбрасывай двусмысленное молча.
- rawSnippet — ДОСЛОВНЫЙ фрагмент исходного текста (5–15 слов), из которого взято значение. Verbatim, не перефразируй.

ПРАВИЛА:
- Не путай число подписчиков с охватом. Если в тексте «5000 подписчиков» — это НЕ reach; пропусти или верни с confidence ≤ 0.2 и пометкой в note.
- Несколько форматов охвата → по точке на формат.
- Демография как «в основном девушки 25-35 из РФ» → три точки: audience.gender ({female: ...}), audience.age ({"25-34": ...}), audience.geo ({"Россия": ...}) с грубыми оценками и confidence ≤ 0.5.
- Нет статистики вообще → пустой data_points + note.

Возвращай только JSON: { data_points: [{ field, value, unit?, confidence, rawSnippet }], note? }.`;

const FALLBACK_USER = `Канал: {{channel_title}} (язык: {{language}})

Ответы блогера (самый свежий — последний):
{{replies_text}}

Структурированный снимок (если есть):
{{structured_snapshot}}

Верни JSON со всеми упомянутыми охватами/просмотрами/демографией/гео как data_points. Сохрани verbatim rawSnippet.`;

export const audienceStatsExtractor: Agent<
  AudienceStatsExtractorInput,
  AudienceStatsExtractorOutput
> = {
  name: 'audience_stats_extractor',
  description:
    'Извлекает охваты/просмотры/демографию/гео блогера как profile_data_point (reach.*, views.avg, audience.*) с confidence и verbatim rawSnippet.',
  inputSchema: audienceStatsExtractorInputSchema,
  outputSchema: audienceStatsExtractorOutputSchema,
  variables: ['channel_title', 'language', 'replies_text', 'structured_snapshot'],
  defaultModel: 'google/gemini-3-flash-preview',
  defaultParams: { temperature: 0.1, max_tokens: 1000 },
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
      outputSchema: audienceStatsExtractorOutputSchema,
      fallbackSystemPrompt: FALLBACK_SYSTEM,
      fallbackUserPromptTemplate: FALLBACK_USER,
    });

    // Deterministic guard: keep ALL points (incl. low-confidence). Backfill
    // rawSnippet from the source only when missing — never threshold-drop.
    const sourceText = replies.join('\n');
    const data_points = out.data_points.map((dp) => ({
      ...dp,
      rawSnippet: dp.rawSnippet && dp.rawSnippet.trim().length > 0 ? dp.rawSnippet : sourceText,
    }));

    return { data_points, ...(out.note !== undefined ? { note: out.note } : {}) };
  },
};
