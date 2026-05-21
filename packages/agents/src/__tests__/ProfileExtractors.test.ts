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
