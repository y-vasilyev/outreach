import { describe, expect, it } from 'vitest';

import {
  extractPlacementOffersFromText,
  PLACEMENT_ATTRIBUTE_REGISTRY_V1,
  validateOfferAttributes,
} from '@nosquare/shared';

import { rateCardExtractor } from '../agents/RateCardExtractor.js';
import { makeCtx, makeConfig, makeLLM } from './_mocks.js';

/**
 * Structured placement offers (entity-style-rate-cards, Section 2).
 * Covers: inline post durations (day vs month stay separate), offsite reviews,
 * tax-as-attribute (no tax price row), ambiguous packages (kept low-confidence,
 * not dropped), and unknown attributes routed to proposals (not active attrs).
 */

const inlineKidfriendlyQuote = `Добрый день) у нас есть формат размещений в тг-канале: пост на сутки 13000, пост на месяц 21000 + налог 6%

А также есть формат выездных обзоров в кидфрендли места: стоимость 30000 (входит пост обзор без удаления + доп пост с упоминанием важных событий и анонсов)`;

describe('extractPlacementOffersFromText (deterministic builders)', () => {
  it('keeps day and month posts as SEPARATE offers with duration attributes', () => {
    const offers = extractPlacementOffersFromText('пост на сутки 13000, пост на месяц 21000');
    const posts = offers.filter((o) => o.kind === 'post');
    expect(posts).toHaveLength(2);
    const durations = posts
      .map((o) => o.attributes.find((a) => a.key === 'duration')?.value)
      .sort();
    expect(durations).toEqual(['day', 'month']);
    expect(posts.map((o) => o.price).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([13000, 21000]);
  });

  it('models tax as an attribute, never a separate offer or price', () => {
    const offers = extractPlacementOffersFromText('пост на месяц 21000 + налог 6%');
    // No offer should be created FOR the tax.
    expect(offers.every((o) => o.kind !== 'other' || o.price !== null)).toBe(true);
    const post = offers.find((o) => o.kind === 'post');
    expect(post).toBeDefined();
    const tax = post?.attributes.find((a) => a.key === 'tax');
    expect(tax).toBeDefined();
    expect(String(tax?.value)).toMatch(/налог/i);
    // No offer carries the tax amount as a price.
    expect(offers.some((o) => o.price === 6)).toBe(false);
  });

  it('extracts offsite reviews with delete_policy and includes attributes', () => {
    const offers = extractPlacementOffersFromText(inlineKidfriendlyQuote);
    const review = offers.find((o) => o.kind === 'offsite_review');
    expect(review).toBeDefined();
    expect(review?.price).toBe(30000);
    expect(review?.attributes.find((a) => a.key === 'delete_policy')?.value).toBe('permanent');
    const includes = review?.attributes.find((a) => a.key === 'includes')?.value;
    expect(Array.isArray(includes) && includes.length > 0).toBe(true);
  });

  it('keeps platform header context on table offers', () => {
    const table = `Telegram — https://t.me/x
Фотопост — 47 000
Видеопост — 53 000`;
    const offers = extractPlacementOffersFromText(table);
    expect(offers.every((o) => o.platform === 'telegram')).toBe(true);
    expect(offers.map((o) => o.price).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([47000, 53000]);
  });

  it('only emits registry-valid attributes (offsite/post)', () => {
    const offers = extractPlacementOffersFromText(inlineKidfriendlyQuote);
    for (const offer of offers) {
      const v = validateOfferAttributes(offer, PLACEMENT_ATTRIBUTE_REGISTRY_V1);
      expect(v.unknown).toEqual([]);
      expect(v.invalid).toEqual([]);
    }
  });
});

describe('rate_card_extractor placement-offer post-processing', () => {
  const baseConfig = makeConfig({ systemPrompt: '', userPromptTemplate: '' });

  it('merges deterministic offers and dedupes vs the LLM', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        data_points: [
          { field: 'rate.post', value: 13000, unit: 'RUB', confidence: 0.86, rawSnippet: 'пост на сутки 13000' },
          { field: 'rate.post', value: 21000, unit: 'RUB', confidence: 0.86, rawSnippet: 'пост на месяц 21000' },
        ],
        placement_offers: [
          {
            kind: 'post',
            platform: 'telegram',
            price: 13000,
            currency: 'RUB',
            attributes: [{ key: 'duration', value: 'day', confidence: 0.9, rawSnippet: 'пост на сутки 13000' }],
            confidence: 0.9,
            rawSnippet: 'пост на сутки 13000',
          },
        ],
        attribute_proposals: [],
      }),
    });
    const ctx = makeCtx({ llm, config: baseConfig });
    const out = await rateCardExtractor.run(
      { replies: [inlineKidfriendlyQuote], last_inbound: inlineKidfriendlyQuote, channel_title: 'kf', language: 'ru' },
      ctx,
    );

    const posts = out.placement_offers.filter((o) => o.kind === 'post');
    // Day vs month posts both survive; the duplicate LLM day-post is deduped.
    const durations = posts
      .map((o) => o.attributes.find((a) => a.key === 'duration')?.value)
      .sort();
    expect(durations).toEqual(['day', 'month']);
    // Tax never becomes its own offer.
    expect(out.placement_offers.some((o) => o.price === 6)).toBe(false);
    // The month post carries the tax attribute.
    const month = posts.find((o) => o.attributes.some((a) => a.key === 'duration' && a.value === 'month'));
    expect(month?.attributes.some((a) => a.key === 'tax')).toBe(true);
  });

  it('keeps an ambiguous package offer at low confidence (not dropped)', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        data_points: [],
        placement_offers: [
          {
            kind: 'package',
            platform: null,
            price: 25000,
            currency: 'RUB',
            attributes: [],
            confidence: 0.4,
            rawSnippet: 'всё вместе пакетом 25000',
          },
        ],
        attribute_proposals: [],
      }),
    });
    const ctx = makeCtx({ llm, config: baseConfig });
    const out = await rateCardExtractor.run(
      { replies: ['всё вместе пакетом 25000'], last_inbound: 'всё вместе пакетом 25000', channel_title: '', language: 'ru' },
      ctx,
    );
    const pkg = out.placement_offers.find((o) => o.kind === 'package');
    expect(pkg).toBeDefined();
    expect(pkg?.confidence).toBeLessThanOrEqual(0.5);
    expect(pkg?.price).toBe(25000);
  });

  it('routes unknown attribute keys to proposals, not active attributes', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        data_points: [],
        placement_offers: [
          {
            kind: 'post',
            platform: 'telegram',
            price: 10000,
            currency: 'RUB',
            attributes: [
              { key: 'duration', value: 'day', confidence: 0.9, rawSnippet: 'пост 10000' },
              // Unknown / inactive key — must NOT survive as an active attribute.
              { key: 'pinned_hours', value: '24', confidence: 0.8, rawSnippet: '24 часа в топе' },
            ],
            confidence: 0.9,
            rawSnippet: 'пост 10000',
          },
        ],
        attribute_proposals: [],
      }),
    });
    const ctx = makeCtx({ llm, config: baseConfig });
    const out = await rateCardExtractor.run(
      { replies: ['пост 10000, 24 часа в топе'], last_inbound: 'пост 10000', channel_title: '', language: 'ru' },
      ctx,
    );
    const post = out.placement_offers.find((o) => o.kind === 'post');
    // Active registry key survives; unknown key stripped from the offer.
    expect(post?.attributes.some((a) => a.key === 'duration')).toBe(true);
    expect(post?.attributes.some((a) => a.key === 'pinned_hours')).toBe(false);
    // Unknown key surfaced as a proposal instead.
    expect(out.attribute_proposals.some((p) => p.suggestedKey === 'pinned_hours')).toBe(true);
  });

  it('preserves the LLM attribute_proposals and dedupes by key', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        data_points: [],
        placement_offers: [
          {
            kind: 'post',
            platform: 'telegram',
            price: 10000,
            currency: 'RUB',
            attributes: [{ key: 'pinned_hours', value: '24', confidence: 0.8, rawSnippet: '24 часа' }],
            confidence: 0.9,
            rawSnippet: 'пост 10000 24 часа',
          },
        ],
        attribute_proposals: [
          {
            suggestedKey: 'pinned_hours',
            suggestedType: 'number',
            applicableKinds: ['post'],
            evidence: ['24 часа в топе'],
            confidence: 0.7,
            rationale: 'часы закрепа',
          },
        ],
      }),
    });
    const ctx = makeCtx({ llm, config: baseConfig });
    const out = await rateCardExtractor.run(
      { replies: ['пост 10000 24 часа'], last_inbound: 'пост 10000 24 часа', channel_title: '', language: 'ru' },
      ctx,
    );
    // Only one proposal for pinned_hours (LLM one wins, not duplicated by the
    // synthesized one from the stripped unknown attribute).
    expect(out.attribute_proposals.filter((p) => p.suggestedKey === 'pinned_hours')).toHaveLength(1);
  });
});
