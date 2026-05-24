import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';

import { mountWithApp } from '../../../__tests__/mount-with-app';
import InboxFilters from '../InboxFilters.vue';

vi.mock('../../../lib/api', () => ({ api: { get: vi.fn() } }));
import { api } from '../../../lib/api';
const apiGet = api.get as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  apiGet.mockReset();
  apiGet.mockResolvedValue([
    { id: 'b', name: 'Beta' },
    { id: 'a', name: 'Alpha' },
  ]);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('InboxFilters', () => {
  it('Clear-all button is hidden when no filter is set', async () => {
    const { wrapper } = mountWithApp(InboxFilters, {
      props: { modelValue: {} },
    });
    await flushPromises();
    expect(wrapper.text()).not.toContain('Сбросить');
  });

  it('Clear-all clears campaignId/status/mode/q but NOT assignedOperatorId', async () => {
    const { wrapper } = mountWithApp(InboxFilters, {
      props: {
        modelValue: {
          campaignId: 'c1',
          status: 'active',
          mode: 'manual',
          q: 'acme',
          assignedOperatorId: 'op-1',
        },
      },
    });
    await flushPromises();
    await wrapper.get('button[title="Сбросить фильтры"]').trigger('click');
    const emitted = wrapper.emitted('update:modelValue');
    expect(emitted).toBeTruthy();
    expect(emitted![0]?.[0]).toEqual({
      campaignId: undefined,
      status: undefined,
      mode: undefined,
      q: undefined,
    });
    // assignedOperatorId is intentionally not in the patch — Decision 5.
  });

  it('deeplinked assignedOperatorId renders a removable chip', async () => {
    const { wrapper } = mountWithApp(InboxFilters, {
      props: { modelValue: { assignedOperatorId: 'op-1' } },
    });
    await flushPromises();
    expect(wrapper.text()).toContain('Оператор');
    expect(wrapper.text()).toContain('op-1');
  });

  it('q input debounces emits — only the final value is emitted after 250ms', async () => {
    const { wrapper } = mountWithApp(InboxFilters, {
      props: { modelValue: {} },
    });
    await flushPromises();
    const input = wrapper.get('input[type="text"]');

    await input.setValue('a');
    await input.setValue('ac');
    await input.setValue('acme');

    // Before the timer fires — no emit yet.
    expect(wrapper.emitted('update:modelValue')).toBeFalsy();

    vi.advanceTimersByTime(250);
    await flushPromises();

    const emitted = wrapper.emitted('update:modelValue');
    expect(emitted).toBeTruthy();
    expect(emitted!.length).toBe(1);
    expect(emitted![0]?.[0]).toEqual({ q: 'acme' });
  });

  it('campaign dropdown sorts options by name', async () => {
    const { wrapper } = mountWithApp(InboxFilters, {
      props: { modelValue: {} },
    });
    await flushPromises();
    const options = wrapper.findAll('option').map((o) => o.text());
    const alpha = options.indexOf('Alpha');
    const beta = options.indexOf('Beta');
    expect(alpha).toBeGreaterThan(-1);
    expect(beta).toBeGreaterThan(alpha);
  });

  it('changing campaign emits a campaignId patch', async () => {
    const { wrapper } = mountWithApp(InboxFilters, {
      props: { modelValue: {} },
    });
    await flushPromises();
    const select = wrapper.findAll('select')[0]!;
    await select.setValue('a');
    const emitted = wrapper.emitted('update:modelValue');
    expect(emitted?.[0]?.[0]).toEqual({ campaignId: 'a' });
  });
});
