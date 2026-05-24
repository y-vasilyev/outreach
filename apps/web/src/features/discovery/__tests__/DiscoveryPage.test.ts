import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises, type DOMWrapper } from '@vue/test-utils';
import { ref } from 'vue';
import { mountWithApp } from '../../../__tests__/mount-with-app';
import DiscoveryPage from '../DiscoveryPage.vue';

// @vue/test-utils' `findAll(selector)` returns `DOMWrapper<Element>[]`
// regardless of the selector, so annotate callbacks with that wider type.
type Btn = DOMWrapper<Element>;

// ── Mocks ──────────────────────────────────────────────────────────────
// Always present — individual tests reach in via `apiGet` / `apiPost`.
vi.mock('../../../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn() },
  ApiError: class ApiError extends Error {
    code: string; status: number;
    constructor(code: string, message: string, status: number) {
      super(message); this.code = code; this.status = status;
    }
  },
}));
import { api } from '../../../lib/api';
const apiGet = api.get as unknown as ReturnType<typeof vi.fn>;
const apiPost = api.post as unknown as ReturnType<typeof vi.fn>;

// Flag accessor — tests flip the boolean inside `flagState.value` to
// exercise the on / off branches.
const flagState = ref({
  campaignTypes: false,
  agencySourcing: false,
  objectStorage: false,
  bloggerMatching: false,
  channelDiscovery: true,
});
vi.mock('../../../lib/config', () => ({ useFlags: () => flagState }));

// Toast — DiscoveryPage calls toast.success/.error on mutation events;
// stub so the test doesn't depend on the real implementation.
vi.mock('../../../lib/toast', () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

// Router — we assert `push('/discovery/batches/<id>')` on batch success.
const routerPush = vi.fn();
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: {} }),
  useRouter: () => ({ push: routerPush }),
}));

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  routerPush.mockReset();
  // Default: feature on, no batches in the list.
  flagState.value.channelDiscovery = true;
  apiGet.mockResolvedValue([]);
});

async function mountAndSettle() {
  const r = mountWithApp(DiscoveryPage);
  await flushPromises();
  return r;
}

describe('DiscoveryPage — feature gate', () => {
  it('renders FeatureOff and skips the batches query when channelDiscovery is off', async () => {
    flagState.value.channelDiscovery = false;
    const { wrapper } = await mountAndSettle();
    // FeatureOff component carries the flag prop into a description string.
    expect(wrapper.text()).toContain('channel_discovery');
    // No batches query fires when the flag is off (route is also unregistered
    // server-side, so the request would just 404).
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('renders the forms and loads the batches list when the flag is on', async () => {
    apiGet.mockResolvedValue([]);
    const { wrapper } = await mountAndSettle();
    expect(wrapper.text()).toContain('Один запрос');
    expect(wrapper.text()).toContain('Batch');
    expect(apiGet).toHaveBeenCalledWith('/discovery/batch');
  });
});

describe('DiscoveryPage — single-niche search', () => {
  it('POSTs /discovery/search with the trimmed query and default limit (20)', async () => {
    apiPost.mockResolvedValue({ query: 'тест', candidates: [], created: 0, enqueued: 0, alreadyKnown: 0 });
    const { wrapper } = await mountAndSettle();
    const queryInput = wrapper.findAll('input.input').find((i) => i.attributes('maxlength') === '300');
    expect(queryInput, 'expected the single-niche query input').toBeDefined();
    await queryInput!.setValue('  тест  ');
    // Submit via the form's "Найти" button.
    const searchBtn = wrapper.findAll('button.btn').find((b: Btn) => b.text().includes('Найти'));
    await searchBtn!.trigger('click');
    await flushPromises();
    expect(apiPost).toHaveBeenCalledWith('/discovery/search', {
      query: 'тест',
      limit: 20,
    });
  });

  it('clampLimit floors and bounds the limit field to [1, 50]', async () => {
    apiPost.mockResolvedValue({ query: 'q', candidates: [], created: 0, enqueued: 0, alreadyKnown: 0 });
    const { wrapper } = await mountAndSettle();
    const queryInput = wrapper.findAll('input.input').find((i) => i.attributes('maxlength') === '300');
    await queryInput!.setValue('тест');
    // Find the single-niche limit input (first input of type=number).
    const limitInput = wrapper.findAll('input[type="number"]').at(0);
    expect(limitInput, 'expected the single-niche limit input').toBeDefined();

    await limitInput!.setValue('0');
    await wrapper.findAll('button.btn').find((b: Btn) => b.text().includes('Найти'))!.trigger('click');
    await flushPromises();
    expect(apiPost).toHaveBeenLastCalledWith('/discovery/search', { query: 'тест', limit: 1 });

    apiPost.mockClear();
    await limitInput!.setValue('999');
    await wrapper.findAll('button.btn').find((b: Btn) => b.text().includes('Найти'))!.trigger('click');
    await flushPromises();
    expect(apiPost).toHaveBeenLastCalledWith('/discovery/search', { query: 'тест', limit: 50 });

    apiPost.mockClear();
    await limitInput!.setValue('not-a-number');
    await wrapper.findAll('button.btn').find((b: Btn) => b.text().includes('Найти'))!.trigger('click');
    await flushPromises();
    // Non-numeric → fallback default 20.
    expect(apiPost).toHaveBeenLastCalledWith('/discovery/search', { query: 'тест', limit: 20 });

    // Regression: cleared field used to be coerced via `Number('')==0` and
    // clamped UP to 1, silently shrinking the discovery scope. The empty
    // guard in clampLimit must restore the default instead.
    apiPost.mockClear();
    await limitInput!.setValue('');
    await wrapper.findAll('button.btn').find((b: Btn) => b.text().includes('Найти'))!.trigger('click');
    await flushPromises();
    expect(apiPost).toHaveBeenLastCalledWith('/discovery/search', { query: 'тест', limit: 20 });
  });

  it('clearing the batch limit also falls back to the default (20), not 1', async () => {
    apiPost.mockResolvedValue({ id: 'b-clear' });
    const { wrapper } = await mountAndSettle();
    const textarea = wrapper.find('textarea.input');
    await textarea.setValue('alpha');
    // Batch limit is the second number input on the page (after the single-niche
    // limit). Clear it and submit.
    const batchLimit = wrapper.findAll('input[type="number"]').at(1);
    expect(batchLimit, 'expected a batch limit input').toBeDefined();
    await batchLimit!.setValue('');
    await wrapper.findAll('button.btn').find((b: Btn) => b.text().includes('Запустить batch'))!.trigger('click');
    await flushPromises();
    expect(apiPost).toHaveBeenCalledWith('/discovery/batch', {
      queries: ['alpha'],
      limit_per_query: 20,
    });
  });
});

describe('DiscoveryPage — batch form', () => {
  async function mountWithBatch(): Promise<{ wrapper: any; textarea: any }> {
    const { wrapper } = await mountAndSettle();
    const textarea = wrapper.find('textarea.input');
    expect(textarea.exists()).toBe(true);
    return { wrapper, textarea };
  }

  it('trims lines, drops blanks, and POSTs only valid niches', async () => {
    apiPost.mockResolvedValue({ id: 'b1' });
    const { wrapper, textarea } = await mountWithBatch();
    await textarea.setValue('  alpha  \n\n  beta\n   \n gamma  ');
    await wrapper.findAll('button.btn').find((b: Btn) => b.text().includes('Запустить batch'))!.trigger('click');
    await flushPromises();
    expect(apiPost).toHaveBeenCalledWith('/discovery/batch', {
      queries: ['alpha', 'beta', 'gamma'],
      limit_per_query: 20,
    });
  });

  it('deduplicates identical niches before submit', async () => {
    apiPost.mockResolvedValue({ id: 'b2' });
    const { wrapper, textarea } = await mountWithBatch();
    await textarea.setValue('alpha\nalpha\nbeta\nalpha');
    await wrapper.findAll('button.btn').find((b: Btn) => b.text().includes('Запустить batch'))!.trigger('click');
    await flushPromises();
    expect(apiPost).toHaveBeenCalledWith('/discovery/batch', {
      queries: ['alpha', 'beta'],
      limit_per_query: 20,
    });
  });

  it('blocks submit when the textarea has no valid lines', async () => {
    const { wrapper, textarea } = await mountWithBatch();
    await textarea.setValue('   \n\n  ');
    const btn = wrapper.findAll('button.btn').find((b: Btn) => b.text().includes('Запустить batch'))!;
    expect(btn.attributes('disabled')).toBeDefined();
    await btn.trigger('click');
    await flushPromises();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('blocks submit and surfaces an overflow error when >50 niches are supplied', async () => {
    const { wrapper, textarea } = await mountWithBatch();
    const fiftyOne = Array.from({ length: 51 }, (_, i) => `niche-${i}`).join('\n');
    await textarea.setValue(fiftyOne);
    const btn = wrapper.findAll('button.btn').find((b: Btn) => b.text().includes('Запустить batch'))!;
    expect(btn.attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain('Не больше 50 ниш');
    await btn.trigger('click');
    await flushPromises();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('allows exactly 50 niches', async () => {
    apiPost.mockResolvedValue({ id: 'b50' });
    const { wrapper, textarea } = await mountWithBatch();
    const fifty = Array.from({ length: 50 }, (_, i) => `niche-${i}`).join('\n');
    await textarea.setValue(fifty);
    const btn = wrapper.findAll('button.btn').find((b: Btn) => b.text().includes('Запустить batch'))!;
    expect(btn.attributes('disabled')).toBeUndefined();
    await btn.trigger('click');
    await flushPromises();
    expect(apiPost).toHaveBeenCalledWith('/discovery/batch', expect.objectContaining({
      queries: expect.arrayContaining(['niche-0', 'niche-49']),
      limit_per_query: 20,
    }));
    expect((apiPost.mock.calls[0]![1] as { queries: string[] }).queries).toHaveLength(50);
  });

  it('on batch success router.push navigates to the status page', async () => {
    apiPost.mockResolvedValue({ id: 'batch-XYZ' });
    const { wrapper, textarea } = await mountWithBatch();
    await textarea.setValue('one\ntwo');
    await wrapper.findAll('button.btn').find((b: Btn) => b.text().includes('Запустить batch'))!.trigger('click');
    await flushPromises();
    expect(routerPush).toHaveBeenCalledWith('/discovery/batches/batch-XYZ');
  });

  it('on batch error does NOT navigate', async () => {
    apiPost.mockRejectedValue(new Error('boom'));
    const { wrapper, textarea } = await mountWithBatch();
    await textarea.setValue('one\ntwo');
    await wrapper.findAll('button.btn').find((b: Btn) => b.text().includes('Запустить batch'))!.trigger('click');
    await flushPromises();
    expect(routerPush).not.toHaveBeenCalled();
  });
});
