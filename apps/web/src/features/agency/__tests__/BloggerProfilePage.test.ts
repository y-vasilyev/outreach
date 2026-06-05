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
  return { api: { get: vi.fn() }, ApiError };
});

import { api } from '../../../lib/api';
const apiGet = api.get as unknown as ReturnType<typeof vi.fn>;

const routerPush = vi.fn();
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: 'p_live' } }),
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
  apiGet.mockImplementation(async (path: string) => {
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
});
