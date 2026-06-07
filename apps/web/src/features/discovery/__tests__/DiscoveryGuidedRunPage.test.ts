import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises, type DOMWrapper } from '@vue/test-utils';
import { ref } from 'vue';
import { mountWithApp } from '../../../__tests__/mount-with-app';
import DiscoveryGuidedRunPage from '../DiscoveryGuidedRunPage.vue';
import type { GuidedRunDetail } from '../types';

type Btn = DOMWrapper<Element>;

vi.mock('../../../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn() },
  ApiError: class ApiError extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
}));
import { api } from '../../../lib/api';
const apiGet = api.get as unknown as ReturnType<typeof vi.fn>;
const apiPost = api.post as unknown as ReturnType<typeof vi.fn>;

const flagState = ref({
  campaignTypes: false,
  agencySourcing: false,
  objectStorage: false,
  bloggerMatching: false,
  channelDiscovery: true,
});
vi.mock('../../../lib/config', () => ({ useFlags: () => flagState }));
vi.mock('../../../lib/toast', () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const routerPush = vi.fn();
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: 'run_1' } }),
  useRouter: () => ({ push: routerPush }),
}));

function detail(over: Partial<GuidedRunDetail> = {}): GuidedRunDetail {
  return {
    id: 'run_1',
    status: 'done',
    createdAt: '2026-06-01T12:00:00.000Z',
    completedAt: '2026-06-01T12:03:00.000Z',
    campaignId: null,
    input: {
      campaignId: null,
      brief: 'B2B fintech founders',
      ajtbd: null,
      platform: 'telegram',
      geo: [],
      language: null,
      budgets: { maxQueries: 8, maxResultsPerQuery: 20, maxCandidates: 40, maxReviewed: 15 },
    },
    plannedQueries: [
      { query: 'финтех основатели', platform: 'telegram', rationale: 'r', signal: 's', negativeTerms: [], confidence: 0.8 },
    ],
    trace: [
      { ts: '2026-06-01T12:00:01.000Z', stage: 'planner.completed', status: 'ok', message: 'planned 1' },
      { ts: '2026-06-01T12:00:05.000Z', stage: 'search.completed', status: 'ok', message: '', query: 'финтех основатели', resultCount: 5, candidateCount: 1 },
    ],
    candidates: [
      {
        id: 'cand_1',
        channelId: 'ch_1',
        platform: 'telegram',
        handle: 'fintechguru',
        url: 'https://t.me/fintechguru',
        title: 'Fintech Guru',
        alreadyKnown: false,
        sourceQueries: ['финтех основатели'],
        enrichmentStatus: 'enriched',
        score: 0.82,
        recommendation: 'strong_fit',
        rationale: 'strong topical match',
        riskNotes: ['low followers'],
        evidence: [
          { postId: 'p1', date: '2026-05-01', snippet: 'про финтех метрики', urls: ['https://t.me/fintechguru/1'], why: 'topic match' },
        ],
        insufficientEvidenceReason: null,
        decision: null,
        followers: 1200,
        hasProfile: true,
        bloggerProfileId: 'prof_1',
      },
    ],
    summary: {
      plannedQueries: 1,
      executedQueries: 1,
      failedQueries: 0,
      candidatesFound: 1,
      candidatesReviewed: 1,
      candidatesSkipped: 0,
      recommended: 1,
      newChannels: 0,
      knownChannels: 1,
      budgets: { maxQueries: 8, maxResultsPerQuery: 20, maxCandidates: 40, maxReviewed: 15 },
    },
    ...over,
  };
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  routerPush.mockReset();
  flagState.value.channelDiscovery = true;
  apiGet.mockResolvedValue(detail());
});

async function mountAndSettle() {
  const r = mountWithApp(DiscoveryGuidedRunPage);
  await flushPromises();
  return r;
}

describe('DiscoveryGuidedRunPage', () => {
  it('fetches the run detail by id', async () => {
    await mountAndSettle();
    expect(apiGet).toHaveBeenCalledWith('/discovery/guided/run_1');
  });

  it('renders status, planned queries, trace and a candidate', async () => {
    const { wrapper } = await mountAndSettle();
    expect(wrapper.text()).toContain('B2B fintech founders');
    expect(wrapper.text()).toContain('финтех основатели'); // planned query + trace
    expect(wrapper.text()).toContain('search.completed'); // trace stage
    expect(wrapper.text()).toContain('fintechguru'); // candidate handle
    expect(wrapper.text()).toContain('strong'); // recommendation label
  });

  it('expands evidence only after clicking the posts toggle', async () => {
    const { wrapper } = await mountAndSettle();
    expect(wrapper.find('[data-test="evidence"]').exists()).toBe(false);
    await wrapper.find('[data-test="toggle-evidence"]').trigger('click');
    await flushPromises();
    const ev = wrapper.find('[data-test="evidence"]');
    expect(ev.exists()).toBe(true);
    expect(ev.text()).toContain('про финтех метрики');
    expect(ev.text()).toContain('topic match');
  });

  it('POSTs a candidate action and refreshes', async () => {
    apiPost.mockResolvedValue({ ok: true });
    const { wrapper } = await mountAndSettle();
    const saveBtn = wrapper.findAll('button.btn').find((b: Btn) => b.text().includes('Сохранить'))!;
    await saveBtn.trigger('click');
    await flushPromises();
    expect(apiPost).toHaveBeenCalledWith(
      '/discovery/guided/run_1/candidates/cand_1/action',
      { action: 'save' },
    );
  });

  it('requests a scrape refresh', async () => {
    apiPost.mockResolvedValue({ ok: true });
    const { wrapper } = await mountAndSettle();
    const btn = wrapper.findAll('button.btn').find((b: Btn) => b.text().includes('Обновить scrape'))!;
    await btn.trigger('click');
    await flushPromises();
    expect(apiPost).toHaveBeenCalledWith(
      '/discovery/guided/run_1/candidates/cand_1/action',
      { action: 'scrape_refresh' },
    );
  });

  it('opens the blogger profile via the stored id', async () => {
    const { wrapper } = await mountAndSettle();
    const btn = wrapper.findAll('button.btn').find((b: Btn) => b.text().includes('Профиль'))!;
    await btn.trigger('click');
    expect(routerPush).toHaveBeenCalledWith('/bloggers/prof_1');
  });

  it('renders FeatureOff when channel discovery is disabled (404 feature-off)', async () => {
    const { ApiError } = await import('../../../lib/api');
    apiGet.mockRejectedValue(new (ApiError as any)('FEATURE_DISABLED', 'off', 404));
    const { wrapper } = await mountAndSettle();
    expect(wrapper.text()).toContain('channel_discovery');
  });
});
