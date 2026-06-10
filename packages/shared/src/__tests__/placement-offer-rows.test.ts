import { describe, it, expect } from 'vitest';
import {
  buildOfferHistory,
  composeOffersFromRows,
  decideOfferRowWrite,
  offerToRowFields,
  rowToOffer,
  type PlacementOfferRowLike,
} from '../placement-offer-rows.js';
import { offerIdentityKey } from '../placement-offers.js';
import { rollUpProfileFields, type RollupDataPoint } from '../profile-rollup.js';
import { extractPlacementOffersFromText } from '../blogger-profile-enrichment.js';
import {
  PlacementOfferDraftZ,
  PlacementOfferZ,
  type PlacementOffer,
} from '../schemas/placement-offer.js';

/**
 * placement-offer-table: pure row mapping, identity, write-decision and
 * compose/history logic. The Prisma plumbing in @nosquare/db is thin around
 * these — the lifecycle semantics are proven here without a database.
 */

function offer(over: Partial<PlacementOffer> = {}): PlacementOffer {
  return PlacementOfferZ.parse({
    kind: 'post',
    platform: 'telegram',
    price: 47000,
    currency: 'RUB',
    attributes: [{ key: 'duration', value: 'month', confidence: 1, rawSnippet: '' }],
    confidence: 0.9,
    rawSnippet: 'пост на месяц 47000',
    sourceMessageId: 'm1',
    extractedBy: 'rate_card_extractor',
    capturedAt: '2026-06-01T00:00:00.000Z',
    ...over,
  });
}

function rowOf(o: PlacementOffer, over: Partial<PlacementOfferRowLike> = {}): PlacementOfferRowLike {
  const f = offerToRowFields(o);
  return {
    id: over.id ?? 'row1',
    platform: f.platform,
    kind: f.kind,
    priceMin: f.priceMin,
    priceMax: f.priceMax,
    currency: f.currency,
    identityKey: f.identityKey,
    status: 'active',
    confidence: f.confidence,
    attributes: f.attributes,
    rawPrice: f.rawPrice,
    rawSnippet: f.rawSnippet,
    sourceMessageId: f.sourceMessageId,
    extractedBy: f.extractedBy,
    capturedAt: f.capturedAt,
    createdAt: f.capturedAt,
    ...over,
  };
}

describe('offerIdentityKey', () => {
  it('same product at a different price → same identity (history chain)', () => {
    expect(offerIdentityKey(offer({ price: 40000 }))).toBe(offerIdentityKey(offer({ price: 47000 })));
  });

  it('day vs month post → distinct identities', () => {
    const day = offer({ attributes: [{ key: 'duration', value: 'day', confidence: 1, rawSnippet: '' }] });
    expect(offerIdentityKey(day)).not.toBe(offerIdentityKey(offer()));
  });

  it('marked seasonal price is a CONCURRENT offer, not a price change', () => {
    const base = offer({ attributes: [{ key: 'price_period', value: 'base', confidence: 1, rawSnippet: '' }] });
    const seasonal = offer({ attributes: [{ key: 'price_period', value: 'seasonal', confidence: 1, rawSnippet: '' }] });
    expect(offerIdentityKey(base)).not.toBe(offerIdentityKey(seasonal));
  });

  it('same-price distinct slots stay distinct', () => {
    const slot1 = offer({ attributes: [{ key: 'slot', value: '1', confidence: 1, rawSnippet: '' }] });
    const slot2 = offer({ attributes: [{ key: 'slot', value: '2', confidence: 1, rawSnippet: '' }] });
    expect(offerIdentityKey(slot1)).not.toBe(offerIdentityKey(slot2));
  });

  it('roll-up grouping is unchanged by the delegation (dedupe = identity + price/currency/snippet)', () => {
    // Two re-quotes of the same offer collapse; a price change stays distinct
    // in the legacy roll-up (it has no supersede) — exactly as before.
    const points: RollupDataPoint[] = [
      { field: 'placement.offer', value: offer(), confidence: 0.9, capturedAt: '2026-06-01T00:00:00.000Z' },
      { field: 'placement.offer', value: offer(), confidence: 0.9, capturedAt: '2026-06-02T00:00:00.000Z' },
      { field: 'placement.offer', value: offer({ price: 40000, rawSnippet: 'пост на месяц 40000' }), confidence: 0.9, capturedAt: '2026-06-03T00:00:00.000Z' },
    ];
    expect(rollUpProfileFields(points).placementOffers).toHaveLength(2);
  });
});

describe('offerToRowFields / rowToOffer', () => {
  it('round-trips an offer with unknown attributes verbatim', () => {
    const o = offer({
      attributes: [
        { key: 'duration', value: 'month', confidence: 1, rawSnippet: '' },
        { key: 'totally_unknown_key', value: 'кейс', confidence: 0.5, rawSnippet: 'кейс' },
      ],
    });
    const back = rowToOffer(rowOf(o));
    expect(back).toEqual(o);
  });

  it('term-only offer stores null price bounds and round-trips', () => {
    const o = offer({ price: null, rawSnippet: 'пост без цены, условия в лс' });
    const f = offerToRowFields(o);
    expect(f.priceMin).toBeNull();
    expect(f.priceMax).toBeNull();
    expect(rowToOffer(rowOf(o))).toEqual(o);
  });

  it('identity attrs are duplicated into columns, not moved out of attributes', () => {
    const f = offerToRowFields(offer());
    expect(f.duration).toBe('month');
    expect(f.attributes.some((a) => a.key === 'duration')).toBe(true);
  });

  it('rawPrice is stashed before price coercion («от 118 000» stays reversible)', () => {
    const draft = PlacementOfferDraftZ.parse({ kind: 'post', price: 'от 118 000' });
    expect(draft.price).toBe(118000);
    expect(draft.rawPrice).toBe('от 118 000');
  });

  it('rowToOffer returns null on unreadable attributes (tolerant, never throws)', () => {
    expect(rowToOffer(rowOf(offer(), { attributes: 'garbage' }))).toBeNull();
  });
});

describe('decideOfferRowWrite', () => {
  const incoming = (over: Partial<{ priceMin: number | null; currency: string; confidence: number; capturedAt: Date }> = {}) => ({
    priceMin: 47000,
    currency: 'RUB',
    confidence: 0.9,
    capturedAt: new Date('2026-06-10T00:00:00Z'),
    ...over,
  });
  const existing = (over: Partial<{ priceMin: number; currency: string; confidence: number; capturedAt: string }> = {}) => ({
    id: 'old',
    priceMin: 40000,
    currency: 'RUB',
    confidence: 0.9,
    capturedAt: '2026-06-01T00:00:00.000Z',
    ...over,
  });

  it('sub-floor confidence → low_confidence, never supersedes', () => {
    expect(decideOfferRowWrite(incoming({ confidence: 0.1 }), existing())).toEqual({
      insertStatus: 'low_confidence',
      supersedeExistingId: null,
      supersededById: null,
    });
  });

  it('no active row → active', () => {
    expect(decideOfferRowWrite(incoming(), null).insertStatus).toBe('active');
  });

  it('price change → new active, prior superseded (the history chain)', () => {
    const d = decideOfferRowWrite(incoming(), existing());
    expect(d.insertStatus).toBe('active');
    expect(d.supersedeExistingId).toBe('old');
  });

  it('same price, comparable confidence → fresher wins', () => {
    const d = decideOfferRowWrite(incoming({ priceMin: 40000 }), existing({ confidence: 0.95 }));
    expect(d.insertStatus).toBe('active');
    expect(d.supersedeExistingId).toBe('old');
  });

  it('same price, much higher existing confidence → incoming lands superseded', () => {
    const d = decideOfferRowWrite(
      incoming({ priceMin: 40000, confidence: 0.5 }),
      existing({ confidence: 0.95 }),
    );
    expect(d).toEqual({ insertStatus: 'superseded', supersedeExistingId: null, supersededById: 'old' });
  });
});

describe('composeOffersFromRows', () => {
  it('only active rows roll up; superseded and low_confidence stay out', () => {
    const current = offer();
    const old = offer({ price: 40000, rawSnippet: 'пост на месяц 40000' });
    const rows = [
      rowOf(old, { id: 'r1', status: 'superseded', createdAt: new Date('2026-05-01T00:00:00Z') }),
      rowOf(current, { id: 'r2', createdAt: new Date('2026-06-01T00:00:00Z') }),
      rowOf(offer({ confidence: 0.1 }), { id: 'r3', status: 'low_confidence' }),
    ];
    const composed = composeOffersFromRows(rows);
    expect(composed).toHaveLength(1);
    expect(composed[0]!.price).toBe(47000);
  });

  it('reports unreadable rows via onSkip without dropping the rest', () => {
    const skipped: string[] = [];
    const rows = [
      rowOf(offer(), { id: 'bad', attributes: 42 }),
      rowOf(offer({ rawSnippet: 'другой оффер' }), { id: 'ok' }),
    ];
    expect(composeOffersFromRows(rows, (id) => skipped.push(id))).toHaveLength(1);
    expect(skipped).toEqual(['bad']);
  });

  // The real failing replies from harden-reply-extraction — the acceptance
  // fixtures for the catalog program. Single-generation extraction must compose
  // IDENTICALLY via offer rows and via the legacy data-point path.
  const ACCEPTANCE_REPLIES = [
    '35 тыс. руб. одна публикация (текст + фото), 40 тыс. руб. (текст + видео) ТГК',
    `Telegram
🔗 https://t.me/tomnayaa
• Фото-пост — 120 000 ₽
• Видео-пост — 170 000 ₽
Цена июня.
• Фото-пост — 135 000 ₽
• Видео-пост — 200 000 ₽`,
    `Час топа / 24 ч. без удаления - 6000₽
Час топа /72ч без удаления — 9000₽
Час топа /месяц без удаления - 12.000₽
https://www.tiktok.com/@green.polina - 7000₽ за 1 ролик`,
    `Основной — 63600, Продвинутый — 53000
пост в ТГ 20 тыс, налог 6%`,
    `ВК/ТГ 267.000, +ютуб/тикток 506.000
фотопост от 118.000, Пакетное размещение - 50 тыс. оба формата`,
  ];

  it.each(ACCEPTANCE_REPLIES.map((reply, i) => [i + 1, reply] as const))(
    'matches the legacy compose path on real failing reply #%i (fixture equality)',
    (_i, reply) => {
      const drafts = extractPlacementOffersFromText(reply);
      const offers = drafts.map((d, i) =>
        PlacementOfferZ.parse({
          ...d,
          sourceMessageId: 'm1',
          extractedBy: 'rate_card_extractor',
          capturedAt: `2026-06-01T00:00:${String(i).padStart(2, '0')}.000Z`,
        }),
      );
      const points: RollupDataPoint[] = offers.map((o) => ({
        field: 'placement.offer',
        value: o,
        confidence: o.confidence,
        capturedAt: o.capturedAt!,
      }));
      const legacy = rollUpProfileFields(points).placementOffers;
      const rows = offers.map((o, i) =>
        rowOf(o, { id: `r${i}`, createdAt: new Date(o.capturedAt!) }),
      );
      const viaRows = rollUpProfileFields(points, {
        placementOffers: composeOffersFromRows(rows),
      }).placementOffers;
      expect(viaRows).toEqual(legacy);
    },
  );
});

describe('buildOfferHistory', () => {
  it('groups a supersede chain: active + prior generations newest first', () => {
    const v1 = rowOf(offer({ price: 40000, capturedAt: '2026-05-01T00:00:00.000Z' }), {
      id: 'r1',
      status: 'superseded',
    });
    (v1 as { supersededById?: string }).supersededById = 'r2';
    const v2 = rowOf(offer({ price: 47000, capturedAt: '2026-06-01T00:00:00.000Z' }), { id: 'r2' });
    const other = rowOf(
      offer({
        attributes: [{ key: 'duration', value: 'day', confidence: 1, rawSnippet: '' }],
        capturedAt: '2026-04-01T00:00:00.000Z',
      }),
      { id: 'r3' },
    );
    const history = buildOfferHistory([v1, v2, other]);
    expect(history).toHaveLength(2);
    const chain = history[0]!;
    expect(chain.active?.id).toBe('r2');
    expect(chain.active?.priceMin).toBe(47000);
    expect(chain.history).toHaveLength(1);
    expect(chain.history[0]!).toMatchObject({ id: 'r1', priceMin: 40000, supersededById: 'r2' });
    expect(history[1]!.active?.id).toBe('r3');
  });
});
