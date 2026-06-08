import { describe, it, expect } from 'vitest';
import { extractPlacementOffersFromText } from '../blogger-profile-enrichment.js';
import type { PlacementOfferDraft } from '../schemas/placement-offer.js';

const prices = (offers: PlacementOfferDraft[]) => offers.map((o) => o.price).sort((a, b) => (a ?? 0) - (b ?? 0));
const attrVals = (o: PlacementOfferDraft, key: string) =>
  o.attributes.filter((a) => a.key === key).map((a) => a.value);

describe('deterministic parser layout coverage (harden-reply-extraction)', () => {
  it('comma-separated per-format price pairs on one line', () => {
    const offers = extractPlacementOffersFromText('Фото-пост 120000, Видео-пост 170000');
    expect(offers).toHaveLength(2);
    expect(prices(offers)).toEqual([120000, 170000]);
  });

  it('inherits a line-level format word for a trailing platform-only fragment', () => {
    const offers = extractPlacementOffersFromText('видеопост ВК/ТГ 267000, +ютуб/тикток 506000');
    expect(prices(offers)).toEqual([267000, 506000]);
    // Each fragment keeps its own platform.
    expect(offers.map((o) => o.platform).sort()).toEqual(['telegram', 'youtube']);
  });

  it('does NOT misread a duration number as a price (single-pair line is left to richer builders)', () => {
    // Only one fragment carries a (format+price); "24 часа в топе" must not
    // become a price-24 offer, and the single "пост 10000" is left for the
    // LLM/other builders rather than emitted as a poorer duplicate here.
    const offers = extractPlacementOffersFromText('пост 10000, 24 часа в топе');
    expect(offers.every((o) => o.price !== 24)).toBe(true);
    expect(offers.find((o) => o.price === 10000)).toBeUndefined();
  });

  it('top-pin duration ladder: each tier is a separate offer, hour tiers preserved in notes', () => {
    const offers = extractPlacementOffersFromText('Час топа/24ч 6000, /72ч 9000, /месяц 12000');
    expect(prices(offers)).toEqual([6000, 9000, 12000]);
    const t72 = offers.find((o) => o.price === 9000)!;
    expect(attrVals(t72, 'notes')).toEqual(['топ 72ч']); // not lost to the enum
    const month = offers.find((o) => o.price === 12000)!;
    expect(attrVals(month, 'duration')).toEqual(['month']);
  });

  it('recognises МАХ as a promoted platform string (not dropped)', () => {
    const offers = extractPlacementOffersFromText('Фото-пост МАХ 25000, Видео-пост МАХ 30000');
    expect(prices(offers)).toEqual([25000, 30000]);
    expect(offers.every((o) => o.platform === 'max')).toBe(true);
  });

  it('"<price> за <format>" one-liner after a profile URL', () => {
    const offers = extractPlacementOffersFromText(
      'https://www.tiktok.com/@green.polina - 7000₽ за 1 ролик',
    );
    expect(offers).toHaveLength(1);
    expect(offers[0]!.price).toBe(7000);
    expect(offers[0]!.platform).toBe('tiktok');
  });

  it('млн multiplier in a price token', () => {
    const offers = extractPlacementOffersFromText('Видео-пост 1.2 млн, Фото-пост 800000');
    expect(prices(offers)).toEqual([800000, 1200000]);
  });

  it('emits MULTIPLE tax attributes for stacked taxes on one line', () => {
    const offers = extractPlacementOffersFromText(
      'пост на сутки 50000, налог 8% ИП, доп налог на рекламу 3%',
    );
    const post = offers.find((o) => o.price === 50000)!;
    expect(attrVals(post, 'tax')).toHaveLength(2);
  });

  it('REGRESSION: existing inline day/month layout still yields exactly two posts with duration + tax (no comma-pair duplication)', () => {
    const offers = extractPlacementOffersFromText('пост на сутки 13000, пост на месяц 21000 + налог 6%');
    const posts = offers.filter((o) => o.kind === 'post');
    expect(posts).toHaveLength(2);
    expect(
      posts.map((o) => o.attributes.find((a) => a.key === 'duration')?.value).sort(),
    ).toEqual(['day', 'month']);
    // tax carried as an attribute, never a separate offer.
    expect(offers.every((o) => o.kind !== 'other')).toBe(true);
  });
});
