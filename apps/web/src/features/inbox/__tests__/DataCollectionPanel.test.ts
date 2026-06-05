import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import { mountWithApp } from '../../../__tests__/mount-with-app';
import DataCollectionPanel from '../DataCollectionPanel.vue';

// API — assert whether the data-collection request is issued.
vi.mock('../../../lib/api', () => ({
  api: { get: vi.fn() },
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

// Flag accessor — flip `dataCollectionHud` to exercise on / off branches.
const flagState = ref({
  campaignTypes: false,
  agencySourcing: false,
  objectStorage: false,
  bloggerMatching: false,
  channelDiscovery: false,
  dataCollectionHud: false,
});
vi.mock('../../../lib/config', () => ({ useFlags: () => flagState }));

// Socket room subscription — noop so the panel doesn't open a real WS.
vi.mock('../../../lib/socket', () => ({ useRoom: vi.fn() }));

beforeEach(() => {
  apiGet.mockReset();
  apiGet.mockResolvedValue({ campaignTypeKey: null, targets: [] });
  flagState.value.dataCollectionHud = false;
});

describe('DataCollectionPanel query gating', () => {
  it('issues no request when data_collection_hud is off', async () => {
    flagState.value.dataCollectionHud = false;
    mountWithApp(DataCollectionPanel, { props: { conversationId: 'c1' } });
    await flushPromises();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('queries the data-collection endpoint when the flag is on', async () => {
    flagState.value.dataCollectionHud = true;
    mountWithApp(DataCollectionPanel, { props: { conversationId: 'c1' } });
    await flushPromises();
    expect(apiGet).toHaveBeenCalledWith('/conversations/c1/data-collection');
  });

  it('shows a setup hint instead of disappearing when the flag is on but no targets resolve', async () => {
    flagState.value.dataCollectionHud = true;
    const { wrapper } = mountWithApp(DataCollectionPanel, { props: { conversationId: 'c1' } });
    await flushPromises();
    expect(wrapper.text()).toContain('Сбор данных');
    expect(wrapper.text()).toContain('не настроены target data points');
  });
});
