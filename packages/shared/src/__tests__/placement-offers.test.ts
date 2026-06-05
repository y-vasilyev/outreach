import { describe, expect, it } from 'vitest';
import {
  PLACEMENT_ATTRIBUTE_REGISTRY_V1,
  derivePlacementFormatKey,
  getOfferAttribute,
  mergeRegistry,
  missingRequiredAttributes,
  offerHasAttribute,
  placementOffersToFormats,
  placementOffersToRateCards,
  validateOfferAttributes,
} from '../placement-offers.js';
import {
  PlacementOfferDraftZ,
  type PlacementAttributeRegistryEntry,
  type PlacementOfferDraft,
} from '../schemas/placement-offer.js';

function offer(partial: Partial<PlacementOfferDraft>): PlacementOfferDraft {
  return PlacementOfferDraftZ.parse({ kind: 'post', ...partial });
}

describe('validateOfferAttributes', () => {
  it('accepts an active, applicable, well-typed attribute', () => {
    const o = offer({
      kind: 'post',
      attributes: [{ key: 'duration', value: 'month', confidence: 0.9, rawSnippet: 'на месяц' }],
    });
    const res = validateOfferAttributes(o);
    expect(res.valid.map((a) => a.key)).toEqual(['duration']);
    expect(res.unknown).toHaveLength(0);
    expect(res.invalid).toHaveLength(0);
  });

  it('does not silently accept an unknown attribute key', () => {
    const o = offer({
      kind: 'post',
      attributes: [{ key: 'exclusivity_window', value: '14 days', confidence: 0.6, rawSnippet: 'эксклюзив 14 дней' }],
    });
    const res = validateOfferAttributes(o);
    expect(res.valid).toHaveLength(0);
    expect(res.unknown.map((a) => a.key)).toEqual(['exclusivity_window']);
  });

  it('rejects an active attribute with a bad enum value or wrong kind', () => {
    const wrongEnum = offer({
      kind: 'post',
      attributes: [{ key: 'duration', value: 'forever', confidence: 0.5, rawSnippet: '' }],
    });
    expect(validateOfferAttributes(wrongEnum).invalid.map((a) => a.key)).toEqual(['duration']);

    const wrongKind = offer({
      kind: 'reels',
      attributes: [{ key: 'duration', value: 'month', confidence: 0.5, rawSnippet: '' }],
    });
    // duration applies only to post/story
    expect(validateOfferAttributes(wrongKind).invalid.map((a) => a.key)).toEqual(['duration']);
  });

  it('treats an inactive registry entry as unknown', () => {
    const registry: PlacementAttributeRegistryEntry[] = mergeRegistry(PLACEMENT_ATTRIBUTE_REGISTRY_V1, [
      {
        key: 'tax',
        valueType: 'string',
        description: 'inactive',
        applicableKinds: [],
        requiredForKinds: [],
        active: false,
      },
    ]);
    const o = offer({ kind: 'post', attributes: [{ key: 'tax', value: 'налог 6%', confidence: 0.9, rawSnippet: '' }] });
    expect(validateOfferAttributes(o, registry).unknown.map((a) => a.key)).toEqual(['tax']);
  });
});

describe('missingRequiredAttributes', () => {
  it('reports duration/delete_policy missing on a bare post price', () => {
    const o = offer({ kind: 'post', platform: 'telegram', price: 21000 });
    const missing = missingRequiredAttributes(o);
    expect(missing).toContain('duration');
    expect(missing).toContain('delete_policy');
  });

  it('does not report a required attribute that is present', () => {
    const o = offer({
      kind: 'post',
      platform: 'telegram',
      price: 21000,
      attributes: [
        { key: 'duration', value: 'month', confidence: 1, rawSnippet: '' },
        { key: 'delete_policy', value: 'permanent', confidence: 1, rawSnippet: '' },
      ],
    });
    expect(missingRequiredAttributes(o)).toEqual([]);
  });

  it('honours campaign extraRequiredKeys', () => {
    const o = offer({ kind: 'offsite_review', platform: 'telegram', price: 30000 });
    expect(missingRequiredAttributes(o, PLACEMENT_ATTRIBUTE_REGISTRY_V1, ['tax'])).toContain('tax');
  });
});

describe('getOfferAttribute / offerHasAttribute', () => {
  it('reads promoted top-level fields', () => {
    const o = offer({ kind: 'post', platform: 'telegram', price: 13000, currency: 'RUB' });
    expect(getOfferAttribute(o, 'kind')).toBe('post');
    expect(getOfferAttribute(o, 'platform')).toBe('telegram');
    expect(getOfferAttribute(o, 'price')).toBe(13000);
    expect(offerHasAttribute(o, 'price')).toBe(true);
    expect(offerHasAttribute(o, 'duration')).toBe(false);
  });
});

describe('derivePlacementFormatKey', () => {
  it('builds platform_post_duration keys matching legacy format', () => {
    expect(
      derivePlacementFormatKey(offer({ kind: 'post', platform: 'telegram', attributes: [{ key: 'duration', value: 'month', confidence: 1, rawSnippet: '' }] })),
    ).toBe('telegram_post_month');
    expect(
      derivePlacementFormatKey(offer({ kind: 'post', platform: 'telegram', attributes: [{ key: 'duration', value: 'day', confidence: 1, rawSnippet: '' }] })),
    ).toBe('telegram_post_day');
  });

  it('keeps offsite_review platform-prefix-free', () => {
    expect(derivePlacementFormatKey(offer({ kind: 'offsite_review', platform: 'telegram' }))).toBe('offsite_review');
  });

  it('falls back to platform_kind without duration', () => {
    expect(derivePlacementFormatKey(offer({ kind: 'integration', platform: 'telegram' }))).toBe('telegram_integration');
    expect(derivePlacementFormatKey(offer({ kind: 'post' }))).toBe('post');
  });
});

describe('placementOffersToRateCards', () => {
  it('does not collapse a day vs month post into one rate card', () => {
    const offers = [
      offer({ kind: 'post', platform: 'telegram', price: 13000, attributes: [{ key: 'duration', value: 'day', confidence: 1, rawSnippet: '' }] }),
      offer({ kind: 'post', platform: 'telegram', price: 21000, attributes: [{ key: 'duration', value: 'month', confidence: 1, rawSnippet: '' }] }),
    ];
    const cards = placementOffersToRateCards(offers);
    expect(cards).toEqual([
      { format: 'telegram_post_day', price: 13000, currency: 'RUB' },
      { format: 'telegram_post_month', price: 21000, currency: 'RUB' },
    ]);
  });

  it('skips offers without a usable price (tax-only / term-only)', () => {
    const offers = [offer({ kind: 'post', platform: 'telegram', price: null })];
    expect(placementOffersToRateCards(offers)).toEqual([]);
  });

  it('derives distinct formats list', () => {
    const offers = [
      offer({ kind: 'post', platform: 'telegram', price: 13000, attributes: [{ key: 'duration', value: 'day', confidence: 1, rawSnippet: '' }] }),
      offer({ kind: 'offsite_review', platform: 'telegram', price: 30000 }),
    ];
    expect(placementOffersToFormats(offers)).toEqual(['telegram_post_day', 'offsite_review']);
  });
});
