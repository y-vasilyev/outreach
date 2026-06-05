import { describe, expect, it } from 'vitest';

import { rateCardExtractor } from '../agents/RateCardExtractor.js';
import { audienceStatsExtractor } from '../agents/AudienceStatsExtractor.js';
import { makeCtx, makeConfig, makeLLM } from './_mocks.js';

/**
 * Profile extractor agents (agency-sourcing-matching M5, task 5.1/5.5):
 * map free-text replies → ProfileDataPointDraft[], preserve verbatim
 * rawSnippet, and flag (not drop) low-confidence/ambiguous facts.
 */
describe('rate_card_extractor', () => {
  const baseConfig = makeConfig({ systemPrompt: '', userPromptTemplate: '' });
  const liveMultiPlatformQuote = `Юрий, добрый день!

*налог на ИП включен

Telegram — https://t.me/polyaam
*1 месяц, 2-3 часа в топе
Фотопост — 47 000
Видеопост — 53 000
Кружок + текст — 54 000

YouTube — https://youtube.com/@polyaam
Интеграция 60-120 секунд (первый слот) — 65 000
Shorts — 42 000

Instagram — https://instagram.com/polyaam?igshid=YmMyMTA2M2Y
Серия сторис — 37 000
Рилс — 87 000

ВКонтакте — https://vk.com/club227874258
Фото-пост — 19 000
ВК-клип — 22 000

Бонусом кросс-постинг в Tik Tok — www.tiktok.com/@polyaamm Статистика https://disk.yandex.ru/d/2BP6ZLLjtiLwyg`;
  const inlineKidfriendlyQuote = `Добрый день) у нас есть формат размещений в тг-канале: пост на сутки 13000, пост на месяц 21000 + налог 6%

А также есть формат выездных обзоров в кидфрендли места: стоимость 30000 (входит пост обзор без удаления + доп пост с упоминанием важных событий и анонсов)`;

  it('maps per-format prices to rate.<format> data points', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        data_points: [
          { field: 'rate.story', value: 8000, unit: 'RUB', confidence: 0.9, rawSnippet: 'сторис 8000' },
          { field: 'rate.post', value: 15000, unit: 'RUB', confidence: 0.92, rawSnippet: 'пост 15000' },
        ],
      }),
    });
    const ctx = makeCtx({ llm, config: baseConfig });
    const out = await rateCardExtractor.run(
      { replies: ['сторис 8000, пост 15000'], last_inbound: '', channel_title: 'X', language: 'ru' },
      ctx,
    );
    expect(out.data_points).toHaveLength(2);
    expect(out.data_points.map((d) => d.field).sort()).toEqual(['rate.post', 'rate.story']);
    expect(out.data_points.find((d) => d.field === 'rate.post')?.value).toBe(15000);
  });

  it('normalizes a bare format name to rate.<format>', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        data_points: [{ field: 'reels', value: 12000, confidence: 0.8, rawSnippet: 'reels 12к' }],
      }),
    });
    const ctx = makeCtx({ llm, config: baseConfig });
    const out = await rateCardExtractor.run({ replies: ['reels 12к'], last_inbound: '', channel_title: '', language: 'ru' }, ctx);
    expect(out.data_points[0]?.field).toBe('rate.reels');
  });

  it('preserves verbatim rawSnippet and keeps low-confidence (ambiguous) points', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        data_points: [
          {
            field: 'rate.other',
            value: 25000,
            confidence: 0.2, // ambiguous: could be a package or reach
            rawSnippet: 'всё вместе 25к',
          },
        ],
        note: 'unclear if package price or reach',
      }),
    });
    const ctx = makeCtx({ llm, config: baseConfig });
    const out = await rateCardExtractor.run({ replies: ['всё вместе 25к'], last_inbound: '', channel_title: '', language: 'ru' }, ctx);
    // NOT dropped despite confidence 0.2 (spec: flagged not dropped silently).
    expect(out.data_points).toHaveLength(1);
    expect(out.data_points[0]?.confidence).toBe(0.2);
    expect(out.data_points[0]?.rawSnippet).toBe('всё вместе 25к');
    expect(out.note).toBeDefined();
  });

  it('backfills rawSnippet from source when the model omits it', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        data_points: [{ field: 'rate.post', value: 5000, confidence: 0.7, rawSnippet: '' }],
      }),
    });
    const ctx = makeCtx({ llm, config: baseConfig });
    const out = await rateCardExtractor.run({ replies: ['пост 5000'], last_inbound: '', channel_title: '', language: 'ru' }, ctx);
    expect(out.data_points[0]?.rawSnippet).toBe('пост 5000');
  });

  it('keeps paid rows from a real multi-platform quote and ignores tax/bonus lines', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        data_points: [
          { field: 'rate.telegram_photo_post', value: 47000, unit: 'RUB', confidence: 0.94, rawSnippet: 'Фотопост — 47 000' },
          { field: 'rate.telegram_video_post', value: 53000, unit: 'RUB', confidence: 0.94, rawSnippet: 'Видеопост — 53 000' },
          { field: 'rate.telegram_round_text', value: 54000, unit: 'RUB', confidence: 0.94, rawSnippet: 'Кружок + текст — 54 000' },
          { field: 'rate.youtube_integration_first_slot', value: 65000, unit: 'RUB', confidence: 0.94, rawSnippet: 'Интеграция 60-120 секунд (первый слот) — 65 000' },
          { field: 'rate.youtube_shorts', value: 42000, unit: 'RUB', confidence: 0.94, rawSnippet: 'Shorts — 42 000' },
          { field: 'rate.instagram_story_series', value: 37000, unit: 'RUB', confidence: 0.94, rawSnippet: 'Серия сторис — 37 000' },
          { field: 'rate.instagram_reels', value: 87000, unit: 'RUB', confidence: 0.94, rawSnippet: 'Рилс — 87 000' },
          { field: 'rate.vk_photo_post', value: 19000, unit: 'RUB', confidence: 0.94, rawSnippet: 'Фото-пост — 19 000' },
          { field: 'rate.vk_clip', value: 22000, unit: 'RUB', confidence: 0.94, rawSnippet: 'ВК-клип — 22 000' },
        ],
        note: 'tax included; TikTok is bonus cross-posting without a price',
      }),
    });
    const ctx = makeCtx({ llm, config: baseConfig });
    const out = await rateCardExtractor.run(
      { replies: [liveMultiPlatformQuote], last_inbound: liveMultiPlatformQuote, channel_title: 'polyaam', language: 'ru' },
      ctx,
    );

    expect(out.data_points).toHaveLength(9);
    expect(out.data_points.map((d) => [d.field, d.value])).toEqual([
      ['rate.telegram_photo_post', 47000],
      ['rate.telegram_video_post', 53000],
      ['rate.telegram_round_text', 54000],
      ['rate.youtube_integration_first_slot', 65000],
      ['rate.youtube_shorts', 42000],
      ['rate.instagram_story_series', 37000],
      ['rate.instagram_reels', 87000],
      ['rate.vk_photo_post', 19000],
      ['rate.vk_clip', 22000],
    ]);
    expect(out.data_points.some((d) => d.field.includes('tax') || d.field.includes('tiktok'))).toBe(false);
    expect(out.data_points.find((d) => d.field === 'rate.youtube_integration_first_slot')?.rawSnippet).toBe(
      'Интеграция 60-120 секунд (первый слот) — 65 000',
    );
  });

  it('recovers platform-specific rates when the model returns generic fields', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        data_points: [
          { field: 'rate.integration', value: 65000, unit: 'RUB', confidence: 0.8, rawSnippet: 'Интеграция 60-120 секунд (первый слот) — 65 000' },
          { field: 'rate.other', value: 54000, unit: 'RUB', confidence: 0.7, rawSnippet: 'Кружок + текст — 54 000' },
          { field: 'rate.post', value: 47000, unit: 'RUB', confidence: 0.8, rawSnippet: 'Фотопост — 47 000' },
          { field: 'rate.reels', value: 87000, unit: 'RUB', confidence: 0.8, rawSnippet: 'Рилс — 87 000' },
          { field: 'rate.story', value: 37000, unit: 'RUB', confidence: 0.8, rawSnippet: 'Серия сторис — 37 000' },
          { field: 'rate.video', value: 53000, unit: 'RUB', confidence: 0.8, rawSnippet: 'Видеопост — 53 000' },
        ],
      }),
    });
    const ctx = makeCtx({ llm, config: baseConfig });
    const out = await rateCardExtractor.run(
      { replies: [liveMultiPlatformQuote], last_inbound: liveMultiPlatformQuote, channel_title: 'polyaam', language: 'ru' },
      ctx,
    );

    expect(out.data_points.map((d) => [d.field, d.value])).toEqual([
      ['rate.telegram_photo_post', 47000],
      ['rate.telegram_video_post', 53000],
      ['rate.telegram_round_text', 54000],
      ['rate.youtube_integration_first_slot', 65000],
      ['rate.youtube_shorts', 42000],
      ['rate.instagram_story_series', 37000],
      ['rate.instagram_reels', 87000],
      ['rate.vk_photo_post', 19000],
      ['rate.vk_clip', 22000],
    ]);
    expect(out.data_points.some((d) => d.field === 'rate.post' || d.field === 'rate.other')).toBe(false);
  });

  it('recovers inline placement terms so same-format post rates do not collapse', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        data_points: [
          { field: 'rate.post', value: 13000, unit: 'RUB', confidence: 0.86, rawSnippet: 'пост на сутки 13000' },
          { field: 'rate.post', value: 21000, unit: 'RUB', confidence: 0.86, rawSnippet: 'пост на месяц 21000' },
          { field: 'rate.other', value: 30000, unit: 'RUB', confidence: 0.7, rawSnippet: 'стоимость 30000' },
        ],
      }),
    });
    const ctx = makeCtx({ llm, config: baseConfig });
    const out = await rateCardExtractor.run(
      { replies: [inlineKidfriendlyQuote], last_inbound: inlineKidfriendlyQuote, channel_title: 'kidfriendly', language: 'ru' },
      ctx,
    );

    expect(out.data_points.map((d) => [d.field, d.value])).toEqual([
      ['rate.telegram_post_day', 13000],
      ['rate.telegram_post_month', 21000],
      ['rate.offsite_review', 30000],
    ]);
    expect(out.data_points.some((d) => d.field === 'rate.post' || d.rawSnippet.includes('налог 6%'))).toBe(false);
  });
});

describe('audience_stats_extractor', () => {
  const baseConfig = makeConfig({ systemPrompt: '', userPromptTemplate: '' });

  it('maps reach mentions to reach.<format> points with verbatim snippets', async () => {
    // The canonical spec example: "охваты сторис ~12к, пост 25к".
    const llm = makeLLM({
      completeJsonImpl: () => ({
        data_points: [
          { field: 'reach.story', value: 12000, confidence: 0.85, rawSnippet: 'охваты сторис ~12к' },
          { field: 'reach.post', value: 25000, confidence: 0.85, rawSnippet: 'пост 25к' },
        ],
      }),
    });
    const ctx = makeCtx({ llm, config: baseConfig });
    const out = await audienceStatsExtractor.run(
      { replies: ['охваты сторис ~12к, пост 25к'], last_inbound: '', channel_title: '', language: 'ru' },
      ctx,
    );
    expect(out.data_points.map((d) => d.field).sort()).toEqual(['reach.post', 'reach.story']);
    expect(out.data_points.find((d) => d.field === 'reach.story')?.rawSnippet).toBe(
      'охваты сторис ~12к',
    );
  });

  it('emits demographics/geo as record values and flags low-confidence guesses', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        data_points: [
          { field: 'audience.geo', value: { Россия: 0.7, Казахстан: 0.1 }, confidence: 0.6, rawSnippet: 'в основном из РФ' },
          { field: 'audience.gender', value: { female: 0.6, male: 0.4 }, confidence: 0.4, rawSnippet: 'больше девушек' },
        ],
      }),
    });
    const ctx = makeCtx({ llm, config: baseConfig });
    const out = await audienceStatsExtractor.run(
      { replies: ['аудитория в основном из РФ, больше девушек'], last_inbound: '', channel_title: '', language: 'ru' },
      ctx,
    );
    expect(out.data_points).toHaveLength(2);
    const geo = out.data_points.find((d) => d.field === 'audience.geo');
    expect((geo?.value as Record<string, number>).Россия).toBe(0.7);
    // Low-confidence gender guess is kept, not dropped.
    expect(out.data_points.find((d) => d.field === 'audience.gender')?.confidence).toBe(0.4);
  });
});
