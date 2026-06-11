import { describe, expect, it } from 'vitest';

import { summarizeOffers } from '../offer-summary';
import { bloggerDisplayTitle, bloggerPlatformLinks } from '../blogger-display';
import type { BloggerProfile, PlacementOffer } from '../types';

function offer(over: Partial<PlacementOffer>): PlacementOffer {
  return {
    kind: 'post',
    platform: 'telegram',
    price: 10000,
    currency: 'RUB',
    attributes: [],
    confidence: 0.9,
    rawSnippet: '',
    sourceMessageId: null,
    extractedBy: 'llm',
    capturedAt: null,
    ...over,
  };
}

describe('summarizeOffers', () => {
  it('prefers normalized ₽ minimum over raw RUB prices', () => {
    const s = summarizeOffers([
      offer({ price: 13000 }),
      offer({
        price: 200,
        currency: 'USD',
        normalized: {
          priceRubMin: 9000,
          priceRubMax: 9000,
          cpmRub: 450,
          fxRateUsed: 45,
          fxAsOf: '2026-06-01',
          viewsBasis: 20000,
          viewsSource: 'profile_avg',
        },
      }),
    ]);
    expect(s.priceFromRub).toBe(9000);
    expect(s.priceStale).toBe(false);
    expect(s.cpmFromRub).toBe(450);
    expect(s.cpmApprox).toBe(true);
  });

  it('excludes non-RUB offers without normalization from the price floor', () => {
    const s = summarizeOffers([offer({ price: 500, currency: 'USD' })]);
    expect(s.priceFromRub).toBeNull();
  });

  it('uses price_min for range offers', () => {
    const s = summarizeOffers([offer({ price: null, price_min: 8000, price_max: 12000 })]);
    expect(s.priceFromRub).toBe(8000);
  });

  it('falls back to stale offers only when no fresh offer has a price', () => {
    const staleOnly = summarizeOffers([offer({ price: 7000, stale: true })]);
    expect(staleOnly.priceFromRub).toBe(7000);
    expect(staleOnly.priceStale).toBe(true);

    const mixed = summarizeOffers([
      offer({ price: 7000, stale: true }),
      offer({ price: 15000 }),
    ]);
    expect(mixed.priceFromRub).toBe(15000);
    expect(mixed.priceStale).toBe(false);
  });

  it('breaks the floor down per platform, nulls last', () => {
    const s = summarizeOffers([
      offer({ price: 13000, platform: 'telegram' }),
      offer({ price: 40000, platform: 'youtube' }),
      offer({ price: 30000, platform: null }),
    ]);
    expect(s.perPlatform).toEqual([
      { platform: 'telegram', priceFromRub: 13000, stale: false },
      { platform: 'youtube', priceFromRub: 40000, stale: false },
      { platform: null, priceFromRub: 30000, stale: false },
    ]);
  });

  it('returns empty summary for no offers', () => {
    const s = summarizeOffers([]);
    expect(s).toEqual({
      priceFromRub: null,
      priceStale: false,
      cpmFromRub: null,
      cpmApprox: false,
      cpmStale: false,
      perPlatform: [],
    });
  });
});

function profile(over: Partial<BloggerProfile>): BloggerProfile {
  return {
    id: 'cmq4tja51001jdr8anfmyymhl',
    channelId: 'cmpxuar67002lwce16srnps6q',
    topics: [],
    languages: [],
    formats: [],
    audience: {},
    rateCards: [],
    reach: null,
    avgViews: null,
    capturedAt: null,
    postInsightRefreshStatus: 'idle',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...over,
  };
}

describe('bloggerDisplayTitle', () => {
  it('never leaks a CUID: the displayName fallback to channelId is rejected', () => {
    expect(bloggerDisplayTitle(profile({ displayName: 'cmpxuar67002lwce16srnps6q' }))).toBe(
      'Без названия',
    );
  });

  it('falls back to channel title or handle before giving up', () => {
    expect(
      bloggerDisplayTitle(
        profile({
          displayName: null,
          channel: { platform: 'telegram', handle: 'g', title: 'Гедонизм', url: null },
        }),
      ),
    ).toBe('Гедонизм');
    expect(
      bloggerDisplayTitle(
        profile({
          displayName: null,
          channel: { platform: 'telegram', handle: 'gedonizm', title: null, url: null },
        }),
      ),
    ).toBe('@gedonizm');
  });
});

describe('bloggerPlatformLinks', () => {
  it('unions social links, platform audiences and offer platforms; primary first', () => {
    const links = bloggerPlatformLinks(
      profile({
        channel: { platform: 'telegram', handle: 'g', title: null, url: 'https://t.me/g' },
        socialLinks: [{ platform: 'youtube', url: 'https://youtube.com/@g', handle: 'g' }],
        platformAudience: [
          { platform: 'instagram', subscribers: 1000, source: 'reply', capturedAt: null },
        ],
        placementOffers: [
          {
            kind: 'post',
            platform: 'vk',
            price: 1000,
            currency: 'RUB',
            attributes: [],
            confidence: 0.9,
            rawSnippet: '',
            sourceMessageId: null,
            extractedBy: 'llm',
            capturedAt: null,
          },
        ],
      }),
    );
    expect(links.map((l) => l.platform)).toEqual(['telegram', 'instagram', 'vk', 'youtube']);
    expect(links[0]).toMatchObject({ primary: true, url: 'https://t.me/g', handle: 'g' });
    expect(links.find((l) => l.platform === 'youtube')).toMatchObject({
      url: 'https://youtube.com/@g',
    });
  });
});
