import { describe, expect, it } from 'vitest';

import {
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
});
