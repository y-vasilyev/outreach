import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { mountWithApp } from '../../../__tests__/mount-with-app';
import DiscoveryBatchStatusPage from '../DiscoveryBatchStatusPage.vue';
import type { DiscoveryBatchStatus } from '../types';

// `vi.mock` factories are hoisted to the top of the file, so any class /
// helper they reference must also be hoisted via `vi.hoisted`. We hoist
// MockApiError so BOTH the mock of lib/api (which exports the class) and
// the mock of lib/featureGate (which does an `instanceof` against it)
// reference the SAME class — otherwise `e instanceof ApiError` in the
// component would never match.
const { MockApiError } = vi.hoisted(() => {
  class MockApiError extends Error {
    code: string; status: number;
    constructor(code: string, message: string, status: number) {
      super(message); this.code = code; this.status = status;
    }
  }
  return { MockApiError };
});

vi.mock('../../../lib/api', () => ({
  api: { get: vi.fn() },
  ApiError: MockApiError,
}));
import { api } from '../../../lib/api';
const apiGet = api.get as unknown as ReturnType<typeof vi.fn>;

vi.mock('../../../lib/featureGate', () => ({
  isFeatureOff: (e: unknown) =>
    e instanceof MockApiError && e.status === 404 && e.code !== 'NOT_FOUND',
}));

const routerPush = vi.fn();
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: 'batch-1' } }),
  useRouter: () => ({ push: routerPush }),
}));

function fixture(overrides: Partial<DiscoveryBatchStatus> = {}): DiscoveryBatchStatus {
  return {
    id: 'batch-1',
    status: 'done',
    createdAt: '2026-05-24T00:00:00.000Z',
    completedAt: '2026-05-24T00:05:00.000Z',
    platform: 'telegram',
    limitPerQuery: 20,
    summary: {
      totals: { queries: 2, processed: 2, created: 3, alreadyKnown: 1, errored: 0 },
      queries: [
        { query: 'alpha', done: true, candidates: [], created: 2, alreadyKnown: 0 },
        { query: 'beta',  done: true, candidates: [], created: 1, alreadyKnown: 1 },
      ],
    },
    ...overrides,
  };
}

beforeEach(() => {
  apiGet.mockReset();
  routerPush.mockReset();
});

describe('DiscoveryBatchStatusPage — render branches', () => {
  it('fetches /discovery/batch/:id from the route id', async () => {
    apiGet.mockResolvedValue(fixture());
    mountWithApp(DiscoveryBatchStatusPage);
    await flushPromises();
    expect(apiGet).toHaveBeenCalledWith('/discovery/batch/batch-1');
  });

  it('renders a spinner before the query resolves', async () => {
    apiGet.mockReturnValue(new Promise(() => {})); // never resolves
    const { wrapper } = mountWithApp(DiscoveryBatchStatusPage);
    await flushPromises();
    expect(wrapper.html()).toContain('class="spinner"');
  });

  it('renders FeatureOff on 404 without NOT_FOUND code (route unregistered)', async () => {
    apiGet.mockRejectedValue(new MockApiError('HTTP_404', 'route not found', 404));
    const { wrapper } = mountWithApp(DiscoveryBatchStatusPage);
    await flushPromises();
    expect(wrapper.text()).toContain('channel_discovery');
  });

  it('renders not-found EmptyState on 404 with NOT_FOUND code (deleted batch)', async () => {
    apiGet.mockRejectedValue(new MockApiError('NOT_FOUND', 'batch not found', 404));
    const { wrapper } = mountWithApp(DiscoveryBatchStatusPage);
    await flushPromises();
    expect(wrapper.text()).toContain('Batch не найден');
    expect(wrapper.text()).not.toContain('channel_discovery');
  });

  it('renders generic-error EmptyState for 500 / non-404 errors', async () => {
    apiGet.mockRejectedValue(new MockApiError('INTERNAL', 'boom 500', 500));
    const { wrapper } = mountWithApp(DiscoveryBatchStatusPage);
    await flushPromises();
    expect(wrapper.text()).toContain('Ошибка загрузки batch');
    expect(wrapper.text()).toContain('boom 500');
    expect(wrapper.text()).not.toContain('Batch не найден');
  });

  it('renders the success branch with totals and per-query rows', async () => {
    apiGet.mockResolvedValue(fixture());
    const { wrapper } = mountWithApp(DiscoveryBatchStatusPage);
    await flushPromises();
    const text = wrapper.text();
    expect(text).toContain('alpha');
    expect(text).toContain('beta');
    expect(text).toContain('telegram');
    // Progress label "2 / 2 ниш"
    expect(text).toContain('2 / 2');
  });

  it('renders the fatal-error banner only when summary.fatalError is set', async () => {
    apiGet.mockResolvedValue(
      fixture({
        status: 'failed',
        summary: {
          totals: { queries: 3, processed: 0, created: 0, alreadyKnown: 0, errored: 0 },
          queries: [
            { query: 'a', done: false, candidates: [], created: 0, alreadyKnown: 0 },
          ],
          fatalError: 'yandex_search integration not configured/disabled',
        },
      }),
    );
    const { wrapper } = mountWithApp(DiscoveryBatchStatusPage);
    await flushPromises();
    expect(wrapper.text()).toContain('Fatal:');
    expect(wrapper.text()).toContain('yandex_search integration not configured/disabled');
  });

  it('does NOT render the fatal banner on a clean done batch', async () => {
    apiGet.mockResolvedValue(fixture());
    const { wrapper } = mountWithApp(DiscoveryBatchStatusPage);
    await flushPromises();
    expect(wrapper.text()).not.toContain('Fatal:');
  });

  // The PageHead sub-text also contains the substring "обновляется", so a
  // text-only assertion is ambiguous. Instead, look for the spinner that
  // only appears next to the in-card hint while the batch is non-terminal.
  it('renders a spinner-marker while status is running', async () => {
    apiGet.mockResolvedValue(fixture({ status: 'running', completedAt: null }));
    const { wrapper } = mountWithApp(DiscoveryBatchStatusPage);
    await flushPromises();
    expect(wrapper.findAll('.spinner').length).toBeGreaterThanOrEqual(1);
  });

  it('does not render the spinner-marker on a terminal status', async () => {
    apiGet.mockResolvedValue(fixture({ status: 'done' }));
    const { wrapper } = mountWithApp(DiscoveryBatchStatusPage);
    await flushPromises();
    expect(wrapper.findAll('.spinner').length).toBe(0);
  });
});
