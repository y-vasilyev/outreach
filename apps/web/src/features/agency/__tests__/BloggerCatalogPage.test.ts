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
  useRouter: () => ({ push: routerPush }),
}));

import BloggerCatalogPage from '../BloggerCatalogPage.vue';

const NOW = '2026-06-04T10:00:00.000Z';

beforeEach(() => {
  vi.clearAllMocks();
  apiGet.mockResolvedValue({
    total: 2,
    limit: 200,
    offset: 0,
    items: [
      {
        id: 'p1',
        channelId: 'chan_1',
        displayName: '@polyaam',
        socialLinks: [{ platform: 'telegram', url: 'https://t.me/polyaam', handle: 'polyaam' }],
        topics: ['стартапы', 'маркетинг'],
        languages: ['ru'],
        formats: ['telegram_post_month'],
        audience: {},
        rateCards: [{ format: 'telegram_post_month', price: 50000, currency: 'RUB' }],
        placementOffers: [],
        reach: 120000,
        avgViews: 34000,
        capturedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
        _count: { dataPoints: 8 },
      },
      {
        id: 'p2',
        channelId: 'chan_2',
        displayName: '@empty',
        socialLinks: [{ platform: 'youtube', url: 'https://youtube.com/@empty', handle: 'empty' }],
        topics: [],
        languages: ['en'],
        formats: [],
        audience: {},
        rateCards: [],
        placementOffers: [],
        reach: null,
        avgViews: null,
        capturedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        _count: { dataPoints: 0 },
      },
    ],
  });
});

describe('BloggerCatalogPage', () => {
  it('renders the blogger catalog as a channels-style list with filters and row navigation', async () => {
    const { wrapper } = mountWithApp(BloggerCatalogPage);
    await flushPromises();

    const text = wrapper.text();
    expect(text).toContain('Каталог блогеров');
    expect(text).toContain('Все');
    expect(text).toContain('С прайсом');
    expect(text).toContain('С охватом');
    expect(text).toContain('Нужны данные');
    expect(text).toContain('Профиль');
    expect(text).toContain('Платф.');
    expect(text).toContain('@polyaam');
    expect(text).toContain('telegram @polyaam');
    expect(text).toContain('telegram_post_month');
    expect(text).toContain('50');
    expect(wrapper.find('.table-wrap table.tbl').exists()).toBe(true);

    await wrapper.find('tbody tr.clickable').trigger('click');
    expect(routerPush).toHaveBeenCalledWith('/bloggers/p1');
  });
});
