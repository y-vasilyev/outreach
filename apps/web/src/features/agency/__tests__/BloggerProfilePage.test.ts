import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';

import { mountWithApp } from '../../../__tests__/mount-with-app';

vi.mock('../../../lib/api', () => {
  class ApiError extends Error {
    constructor(
      message: string,
      public status: number,
      public code?: string,
    ) {
      super(message);
    }
  }
  return { api: { get: vi.fn(), post: vi.fn() }, ApiError };
});

import { api } from '../../../lib/api';
const apiGet = api.get as unknown as ReturnType<typeof vi.fn>;

const routerPush = vi.fn();
const routeState = { id: 'p_live' };
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: routeState.id } }),
  useRouter: () => ({ push: routerPush }),
  RouterLink: { name: 'RouterLink', template: '<a><slot /></a>' },
}));

import BloggerProfilePage from '../BloggerProfilePage.vue';

const NOW = '2026-06-04T10:00:00.000Z';

const rateCards = [
  { format: 'telegram_photo_post', price: 47000, currency: 'RUB' },
  { format: 'telegram_video_post', price: 53000, currency: 'RUB' },
  { format: 'telegram_round_text', price: 54000, currency: 'RUB' },
  { format: 'youtube_integration_first_slot', price: 65000, currency: 'RUB' },
  { format: 'youtube_shorts', price: 42000, currency: 'RUB' },
  { format: 'instagram_story_series', price: 37000, currency: 'RUB' },
  { format: 'instagram_reels', price: 87000, currency: 'RUB' },
  { format: 'vk_photo_post', price: 19000, currency: 'RUB' },
  { format: 'vk_clip', price: 22000, currency: 'RUB' },
];

beforeEach(() => {
  vi.clearAllMocks();
  routeState.id = 'p_live';
  apiGet.mockImplementation(async (path: string) => {
    if (path === '/blogger-profiles/p_offers') {
      return profileWithOffers;
    }
    if (path === '/blogger-profiles/p_live') {
      return {
        id: 'p_live',
        channelId: 'chan_live',
        displayName: '@polyaam',
        socialLinks: [
          { platform: 'telegram', url: 'https://t.me/polyaam', handle: 'polyaam' },
          { platform: 'youtube', url: 'https://youtube.com/@polyaam', handle: 'polyaam' },
          { platform: 'instagram', url: 'https://instagram.com/polyaam', handle: 'polyaam' },
          { platform: 'vk', url: 'https://vk.com/club227874258', handle: 'club227874258' },
        ],
        topics: [],
        languages: ['ru'],
        formats: rateCards.map((r) => r.format),
        audience: {},
        rateCards,
        reach: null,
        avgViews: null,
        capturedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
        postInsightRefreshStatus: 'idle',
        postInsightRefreshError: null,
        postInsights: [
          {
            id: 'post1',
            profileId: 'p_live',
            channelId: 'chan_live',
            platform: 'telegram',
            externalPostId: '42',
            url: 'https://t.me/polyaam/42',
            publishedAt: NOW,
            textSnippet: 'финтех пост с хорошими просмотрами',
            mediaKind: 'post',
            metrics: { views: 45000, reactions: 300 },
            metricCapturedAt: NOW,
            source: 'telegram_public_parse',
            freshness: { state: 'fresh', ageDays: 0 },
            performanceScore: 0.8,
          },
        ],
        dataPoints: rateCards.map((r, i) => ({
          id: `dp_live_${i}`,
          profileId: 'p_live',
          field: `rate.${r.format}`,
          value: r.price,
          unit: r.currency,
          confidence: 0.94,
          extractedBy: 'rate_card_extractor',
          sourceMessageId: 'm_live',
          rawSnippet: `${r.format} — ${r.price}`,
          capturedAt: NOW,
          createdAt: NOW,
        })),
        mediaAssets: [],
        freshness: {
          rateCards: { stale: false, ageDays: 0 },
          audience: { stale: true, ageDays: null },
          topics: { stale: true, ageDays: null },
          languages: { stale: true, ageDays: null },
          formats: { stale: false, ageDays: 0 },
          reach: { stale: true, ageDays: null },
          avgViews: { stale: true, ageDays: null },
        },
      };
    }
    throw new Error(`unexpected GET ${path}`);
  });
});

const profileWithOffers = {
  id: 'p_offers',
  channelId: 'chan_offers',
  displayName: '@offers',
  socialLinks: [],
  topics: [],
  languages: ['ru'],
  formats: ['telegram_post_day', 'telegram_post_month', 'offsite_review'],
  audience: {},
  rateCards: [
    { format: 'telegram_post_day', price: 13000, currency: 'RUB' },
    { format: 'telegram_post_month', price: 21000, currency: 'RUB' },
    { format: 'offsite_review', price: 30000, currency: 'RUB' },
  ],
  placementOffers: [
    {
      kind: 'post',
      platform: 'telegram',
      price: 13000,
      currency: 'RUB',
      attributes: [{ key: 'duration', value: 'day', confidence: 1, rawSnippet: 'на сутки' }],
      confidence: 0.9,
      rawSnippet: 'пост на сутки 13000',
      sourceMessageId: 'm_offers',
      extractedBy: 'rate_card_extractor',
      capturedAt: NOW,
    },
    {
      kind: 'post',
      platform: 'telegram',
      price: 21000,
      currency: 'RUB',
      attributes: [
        { key: 'duration', value: 'month', confidence: 1, rawSnippet: 'на месяц' },
        { key: 'tax', value: 'налог 6%', confidence: 0.8, rawSnippet: '+ налог 6%' },
      ],
      confidence: 0.9,
      rawSnippet: 'пост на месяц 21000 + налог 6%',
      sourceMessageId: 'm_offers',
      extractedBy: 'rate_card_extractor',
      capturedAt: NOW,
    },
    {
      kind: 'offsite_review',
      platform: null,
      price: 30000,
      currency: 'RUB',
      attributes: [
        { key: 'delete_policy', value: 'permanent', confidence: 0.9, rawSnippet: 'без удаления' },
        { key: 'includes', value: ['доп пост'], confidence: 0.7, rawSnippet: '' },
      ],
      confidence: 0.85,
      rawSnippet: 'выездной обзор 30000 без удаления',
      sourceMessageId: 'm_offers',
      extractedBy: 'rate_card_extractor',
      capturedAt: NOW,
    },
  ],
  reach: null,
  avgViews: null,
  capturedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  dataPoints: [],
  mediaAssets: [],
};

describe('BloggerProfilePage', () => {
  it('renders real multi-platform quote prices in the profile card', async () => {
    const { wrapper } = mountWithApp(BloggerProfilePage, {
      global: {
        stubs: {
          MediaKitDownload: { template: '<button>Скачать</button>' },
        },
      },
    });
    await flushPromises();

    const text = wrapper.text();
    expect(text).toContain('@polyaam');
    expect(text).toContain('Соцпрофили');
    expect(text).toContain('telegram @polyaam');
    expect(text).toContain('youtube @polyaam');
    expect(text).toContain('Прайс (9)');
    expect(text).toContain('Топ-посты (1)');
    expect(text).toContain('финтех пост с хорошими просмотрами');
    expect(text).toContain('45');
    expect(text).toContain('telegram_photo_post');
    expect(text).toContain('youtube_integration_first_slot');
    expect(text).toContain('instagram_reels');
    expect(text).toContain('vk_clip');
    expect(text).toContain('RUB');
    expect(text).toContain('47');
    expect(text).toContain('87');
    expect(text).toContain('Точки данных (9)');
    expect(text).toContain('rate.telegram_photo_post');
    expect(text).not.toContain('tiktok');
    expect(text).not.toContain('tax');
  });

  it('falls back to the legacy rate-card table when there are no structured offers', async () => {
    const { wrapper } = mountWithApp(BloggerProfilePage, {
      global: { stubs: { MediaKitDownload: { template: '<button>Скачать</button>' } } },
    });
    await flushPromises();

    const text = wrapper.text();
    // No structured "Размещения" card when placementOffers is absent.
    expect(text).not.toContain('Размещения');
    // Legacy "Прайс" table still renders.
    expect(text).toContain('Прайс (9)');
  });

  it('renders structured placement offers with terms and source snippets', async () => {
    routeState.id = 'p_offers';
    const { wrapper } = mountWithApp(BloggerProfilePage, {
      global: { stubs: { MediaKitDownload: { template: '<button>Скачать</button>' } } },
    });
    await flushPromises();

    const text = wrapper.text();
    // Structured offers card present with all three offers.
    expect(text).toContain('Размещения (3)');
    // Kind + platform + price+currency rendered.
    expect(text).toContain('Пост');
    expect(text).toContain('Выездной обзор');
    expect(text).toContain('telegram');
    expect(text).toContain('RUB');
    // Distinct day vs month prices both present (no collapse).
    expect(text).toContain('13');
    expect(text).toContain('21');
    expect(text).toContain('30');
    // Typed terms rendered with localized labels.
    expect(text).toContain('Срок');
    expect(text).toContain('month');
    expect(text).toContain('Налог');
    expect(text).toContain('налог 6%');
    expect(text).toContain('Удаление');
    expect(text).toContain('Входит');
    // Source snippet shown as the audit affordance back to the message.
    expect(text).toContain('пост на месяц 21000 + налог 6%');
  });
});
