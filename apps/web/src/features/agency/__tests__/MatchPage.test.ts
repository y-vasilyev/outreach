import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { mountWithApp } from '../../../__tests__/mount-with-app';

vi.mock('../../../lib/api', () => ({ api: { post: vi.fn() } }));
vi.mock('../../../lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { api } from '../../../lib/api';
import MatchPage from '../MatchPage.vue';

const apiPost = api.post as unknown as ReturnType<typeof vi.fn>;
const NOW = '2026-06-07T00:00:00.000Z';

beforeEach(() => {
  vi.clearAllMocks();
  apiPost.mockImplementation(async (path: string) => {
    if (path === '/ad-briefs') {
      return { id: 'brief1', topic: 'финтех', audienceTarget: '', budget: null, formats: [], geo: [], deadline: null, notes: '', createdAt: NOW };
    }
    if (path === '/ad-briefs/brief1/match') {
      return {
        briefId: 'brief1',
        candidates: [
          {
            score: 0.82,
            rationale: 'topic and post evidence fit',
            rerankedByLlm: false,
            fit: {
              score: 0.82,
              rationale: 'topic and post evidence fit',
              positiveSignals: ['topic match: финтех'],
              gaps: ['rate card is missing'],
              evidencePostIds: ['post1'],
              scoreBreakdown: { total: 0.82 },
            },
            profile: {
              id: 'p1',
              channelId: 'ch1',
              displayName: '@fintech',
              socialLinks: [],
              topics: ['финтех'],
              languages: ['ru'],
              formats: ['telegram_post'],
              audience: {},
              rateCards: [],
              placementOffers: [],
              reach: 10000,
              avgViews: 5000,
              capturedAt: NOW,
              postInsightRefreshStatus: 'idle',
              topPostsPreview: [
                {
                  id: 'post1',
                  profileId: 'p1',
                  channelId: 'ch1',
                  platform: 'telegram',
                  externalPostId: '42',
                  url: 'https://t.me/fintech/42',
                  publishedAt: NOW,
                  textSnippet: 'финтех для founders',
                  mediaKind: 'post',
                  metrics: { views: 9000 },
                  metricCapturedAt: NOW,
                  source: 'telegram_public_parse',
                  freshness: { state: 'fresh', ageDays: 0 },
                  performanceScore: 0.8,
                },
              ],
              createdAt: NOW,
              updatedAt: NOW,
            },
          },
        ],
      };
    }
    throw new Error(`unexpected POST ${path}`);
  });
});

describe('MatchPage', () => {
  it('renders structured fit signals and linked post evidence', async () => {
    const { wrapper } = mountWithApp(MatchPage);
    await wrapper.find('input').setValue('финтех');
    await wrapper.find('button.primary').trigger('click');
    await flushPromises();

    const text = wrapper.text();
    expect(text).toContain('@fintech');
    expect(text).toContain('Сигналы');
    expect(text).toContain('topic match: финтех');
    expect(text).toContain('Гэпы');
    expect(text).toContain('rate card is missing');
    expect(text).toContain('Посты-доказательства');
    expect(text).toContain('финтех для founders');
  });
});
