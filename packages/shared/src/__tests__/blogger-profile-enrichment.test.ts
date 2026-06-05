import { describe, expect, it } from 'vitest';

import {
  extractPlacementOffersFromText,
  extractRateCardDataPointsFromText,
  rateCardsFromDataPoints,
} from '../blogger-profile-enrichment.js';

describe('blogger profile enrichment', () => {
  const inlineKidfriendlyQuote = `Добрый день) у нас есть формат размещений в тг-канале: пост на сутки 13000, пост на месяц 21000 + налог 6%

А также есть формат выездных обзоров в кидфрендли места: стоимость 30000 (входит пост обзор без удаления + доп пост с упоминанием важных событий и анонсов)`;

  it('extracts inline post terms and offsite review rates without tax rows', () => {
    const points = extractRateCardDataPointsFromText(inlineKidfriendlyQuote);

    expect(points.map((p) => [p.field, p.value, p.unit])).toEqual([
      ['rate.telegram_post_day', 13000, 'RUB'],
      ['rate.telegram_post_month', 21000, 'RUB'],
      ['rate.offsite_review', 30000, 'RUB'],
    ]);
    expect(points.map((p) => p.rawSnippet)).toEqual([
      'пост на сутки 13000',
      'пост на месяц 21000',
      'А также есть формат выездных обзоров в кидфрендли места: стоимость 30000',
    ]);
    expect(points.some((p) => p.field.includes('tax') || p.rawSnippet.includes('налог 6%'))).toBe(false);
    expect(rateCardsFromDataPoints(points)).toEqual([
      { format: 'telegram_post_day', price: 13000, currency: 'RUB' },
      { format: 'telegram_post_month', price: 21000, currency: 'RUB' },
      { format: 'offsite_review', price: 30000, currency: 'RUB' },
    ]);
  });

  // Regression: prose "стоимость <format> <price>" with the «тыс рублей» word
  // form was previously dropped by both deterministic extractors.
  describe('labeled prose price with тыс/рублей word forms', () => {
    const proseQuote = 'стоимость рекламного поста 50 тыс рублей';

    it('legacy extractor parses the post price (тыс → ×1000)', () => {
      const points = extractRateCardDataPointsFromText(proseQuote);
      expect(points.map((p) => [p.field, p.value, p.unit])).toEqual([
        ['rate.post', 50000, 'RUB'],
      ]);
      expect(rateCardsFromDataPoints(points)).toEqual([
        { format: 'post', price: 50000, currency: 'RUB' },
      ]);
    });

    it('offer extractor produces a structured post offer', () => {
      const offers = extractPlacementOffersFromText(proseQuote);
      expect(offers).toHaveLength(1);
      expect(offers[0]).toMatchObject({ kind: 'post', platform: null, price: 50000, currency: 'RUB' });
    });

    it('handles цена/прайс variants and к/k multipliers', () => {
      expect(extractRateCardDataPointsFromText('цена сторис — 8000').map((p) => [p.field, p.value])).toEqual([
        ['rate.story', 8000],
      ]);
      expect(extractRateCardDataPointsFromText('прайс на пост 21к').map((p) => [p.field, p.value])).toEqual([
        ['rate.post', 21000],
      ]);
    });

    it('does not misread a bare view count as a rate (no price word)', () => {
      expect(extractPlacementOffersFromText('пост набрал 50000 просмотров')).toEqual([]);
      expect(extractRateCardDataPointsFromText('пост набрал 50000 просмотров')).toEqual([]);
    });
  });
});
