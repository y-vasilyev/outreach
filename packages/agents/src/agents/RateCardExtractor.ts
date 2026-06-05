import { z } from 'zod';
import { extractRateCardDataPointsFromText, ProfileExtractionOutputZ } from '@nosquare/shared';

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

    // Deterministic guards (harden-agency-sourcing-pipeline):
    // 1. Field MUST match `rate.<format>` where format is a plain
    //    `[a-z][a-z0-9_]*` token. The previous implementation blindly
    //    prepended `rate.` to anything (so `reach.story` accidentally
    //    becomes `rate.reach.story` and the roll-up reads it as a "format"
    //    with no price). Now:
    //      - bare `post` + numeric value → `rate.post`
    //      - `rate.post` → kept
    //      - `rate.reach.story` (multi-dot) → bucketed to `rate.other`
    //      - `reach.story` (other category) → DROPPED (it's not our scope)
    // 2. Preserve verbatim rawSnippet, backfilling from source text only
    //    when the model omitted it (provenance never lost).
    // 3. Keep low-confidence points (the spec wants the operator to see
    //    ambiguous facts; never threshold-drop here).
    const RATE_FORMAT_RE = /^rate\.[a-z][a-z0-9_]*$/;
    const PLAIN_FORMAT_RE = /^[a-z][a-z0-9_]*$/;
    const isNumeric = (v: unknown): boolean => {
      if (typeof v === 'number') return Number.isFinite(v);
      if (typeof v === 'string') return Number.isFinite(Number(v.replace(/[\s,]/g, '')));
      return false;
    };
    const sourceText = replies.join('\n');
    const data_points: typeof out.data_points = [];
    for (const dp of out.data_points) {
      const f = (dp.field ?? '').trim().toLowerCase();
      let normalized: string | null = null;
      if (RATE_FORMAT_RE.test(f)) {
        normalized = f;
      } else if (PLAIN_FORMAT_RE.test(f) && isNumeric(dp.value)) {
        normalized = `rate.${f}`;
      } else if (f.startsWith('rate.') && isNumeric(dp.value)) {
        // multi-segment like `rate.zoom.lecture` or `rate.reach.story` —
        // we have a price, just don't know the canonical format. Bucket.
        normalized = 'rate.other';
      } else {
        // Not a rate field and not a numeric price — drop. Audience/reach
        // belongs to AudienceStatsExtractor.
        continue;
      }
      data_points.push({
        ...dp,
        field: normalized,
        rawSnippet:
          dp.rawSnippet && dp.rawSnippet.trim().length > 0 ? dp.rawSnippet : sourceText,
      });
    }

    // Structured multi-platform quotes often have explicit platform headers:
    // "Telegram — <url>" followed by "Фотопост — 47 000". If the LLM emits
    // generic `rate.post` / `rate.video` rows, the catalog loses the platform
    // context even though it is deterministic in the source text. Recover those
    // rows locally and let them supersede generic rows with the same price or
    // snippet.
    const deterministic = extractRateCardDataPointsFromText(sourceText);
    if (deterministic.length === 0) {
      return { data_points, ...(out.note !== undefined ? { note: out.note } : {}) };
    }

    const deterministicPrices = new Set(deterministic.map((dp) => String(dp.value)));
    const deterministicSnippets = new Set(
      deterministic.map((dp) => dp.rawSnippet.trim().toLowerCase()).filter(Boolean),
    );
    const genericRateFields = new Set([
      'rate.integration',
      'rate.other',
      'rate.post',
      'rate.reels',
      'rate.shorts',
      'rate.story',
      'rate.video',
    ]);
    const remainingModelPoints = data_points.filter((dp) => {
      const snippet = dp.rawSnippet.trim().toLowerCase();
      if (snippet && deterministicSnippets.has(snippet)) return false;
      if (genericRateFields.has(dp.field) && deterministicPrices.has(String(dp.value))) return false;
      return true;
    });

    return {
      data_points: [...deterministic, ...remainingModelPoints],
      ...(out.note !== undefined ? { note: out.note } : {}),
    };
  },
};
