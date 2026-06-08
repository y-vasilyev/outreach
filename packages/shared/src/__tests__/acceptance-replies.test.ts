import { describe, it, expect } from 'vitest';
import { extractPlacementOffersFromText } from '../blogger-profile-enrichment.js';
import { normalizePriceToken } from '../price.js';

/**
 * Acceptance fixtures — the five REAL blogger replies where catalog creation
 * previously failed (harden-reply-extraction). Each asserts the facts the
 * DETERMINISTIC parser must now land losslessly. Prose-heavy parts (bare
 * "<format> <price>" without a separator, multi-sentence quotes) are handled by
 * the LLM extractor at runtime and are intentionally OUT OF SCOPE for the
 * deterministic floor here — those are noted per fixture. Facts that need NEW
 * schema fields (per-platform audience, package/bundle, named tariffs+slots,
 * base-vs-season pricing) are deferred to `placement-representation-v2`.
 */

const prices = (t: string) =>
  extractPlacementOffersFromText(t)
    .map((o) => o.price)
    .filter((p): p is number => typeof p === 'number')
    .sort((a, b) => a - b);

describe('acceptance: real failing replies', () => {
  it('1. multi-platform doctor — per-format pair with ТГК platform (comma layout)', () => {
    const offers = extractPlacementOffersFromText(
      '35 тыс. руб. одна публикация (текст + фото), 40 тыс. руб. (текст + видео) ТГК',
    );
    expect(offers).toHaveLength(2);
    expect(offers.map((o) => o.price).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([35000, 40000]);
    expect(offers.every((o) => o.platform === 'telegram')).toBe(true);
    // DEFERRED to placement-representation-v2: МАХ per-platform prices,
    // package ("Пакетное 50 тыс"), prepayment, ИП tax regime.
  });

  it('2. tomnayaa — Telegram em-dash table, base AND June prices, thousands-dot', () => {
    const reply = `Telegram
🔗 https://t.me/tomnayaa
• Фото-пост — 120 000 ₽
• Видео-пост — 170 000 ₽
Цена июня.
• Фото-пост — 135 000 ₽
• Видео-пост — 200 000 ₽`;
    // All four prices land (base + June) — none overwritten.
    expect(prices(reply)).toEqual([120000, 135000, 170000, 200000]);
    // DEFERRED: marking which pair is base vs June (price_period) — v2.
  });

  it('3. час-топа ladder + tiktok ролик — every tier lands, hour tiers preserved', () => {
    const reply = `Час топа / 24 ч. без удаления - 6000₽
Час топа /72ч без удаления — 9000₽
Час топа /месяц без удаления - 12.000₽
https://www.tiktok.com/@green.polina - 7000₽ за 1 ролик`;
    const offers = extractPlacementOffersFromText(reply);
    expect(offers.map((o) => o.price).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      6000, 7000, 9000, 12000,
    ]);
    // 72ч hour tier preserved in notes (not forced into the day/week/month enum).
    const t72 = offers.find((o) => o.price === 9000)!;
    expect(t72.attributes.some((a) => a.key === 'notes' && /72/.test(String(a.value)))).toBe(true);
    expect(offers.find((o) => o.price === 7000)!.platform).toBe('tiktok');
  });

  it('4. scandi & 5. natali — prices coerce even where prose needs the LLM', () => {
    // Deterministic parsing of these multi-sentence quotes is the LLM's job;
    // what this change GUARANTEES is that every price token in them coerces to a
    // number (no zod rejection, thousands-dot, "от", млн) so nothing is dropped
    // once the LLM emits the offers.
    expect(normalizePriceToken('63600')).toBe(63600); // scandi tariff
    expect(normalizePriceToken('20 тыс')).toBe(20000); // scandi TG post
    expect(normalizePriceToken('267.000')).toBe(267000); // natali ВК/ТГ
    expect(normalizePriceToken('506.000')).toBe(506000); // natali +ютуб/тикток
    expect(normalizePriceToken('от 118.000')).toBe(118000); // natali фотопост "от"
    expect(normalizePriceToken('1,2млн')).toBe(1200000); // natali инст audience scale
    // DEFERRED to placement-representation-v2: named tariffs+slots (scandi
    // "Основной/Продвинутый, слот 1/2"), per-platform audience sizes (natali
    // Инст 1.2млн / ТГ 15тыс / ВК 45тыс), package/bundle objects.
  });
});
