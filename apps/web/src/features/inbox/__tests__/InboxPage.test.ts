import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { flushPromises } from '@vue/test-utils';

import { mountWithApp } from '../../../__tests__/mount-with-app';

// We pull in the page after the mocks below register, because the page
// imports `api` and `vue-router` at module load.
vi.mock('../../../lib/api', () => ({ api: { get: vi.fn() } }));
import { api } from '../../../lib/api';
const apiGet = api.get as unknown as ReturnType<typeof vi.fn>;

// Router doubles. We surface a mutable `routeState` so tests can update
// the route between assertions (e.g. simulate navigation).
const routeState = ref<{
  name: string;
  params: Record<string, string>;
  query: Record<string, string>;
}>({ name: 'inbox', params: {}, query: {} });
const routerPush = vi.fn();
const routerReplace = vi.fn();
vi.mock('vue-router', () => ({
  useRoute: () => routeState.value,
  useRouter: () => ({ push: routerPush, replace: routerReplace }),
  RouterLink: { name: 'RouterLink', template: '<a><slot /></a>' },
}));

import InboxPage from '../InboxPage.vue';

beforeEach(() => {
  apiGet.mockReset();
  routerPush.mockReset();
  routerReplace.mockReset();
  routeState.value = { name: 'inbox', params: {}, query: {} };
  // `api.get(path, options?)` — the mock receives the original path
  // (before appendQuery), so we match on path then key off the call
  // shape. For the list call we look at the second arg `{ params }`.
  apiGet.mockImplementation(async (path: string) => {
    if (path === '/conversations') {
      return [
        {
          id: 'conv-1',
          contact: { id: 'co-1', value: '@alpha', channel: { handle: 'alpha', title: 'Alpha', platform: 'telegram' } },
          status: 'active',
          mode: 'assisted',
          campaign: { id: 'camp-1', name: 'Camp' },
        },
      ];
    }
    if (path === '/campaigns') return [];
    if (path.startsWith('/conversations/') && path.endsWith('/suggestions')) return [];
    if (path.startsWith('/conversations/')) {
      return {
        id: 'conv-X',
        contact: { id: 'co-X', value: '@outside', channel: { handle: 'outside', title: 'Outside', platform: 'telegram' } },
        status: 'active',
        mode: 'assisted',
      };
    }
    return [];
  });
});

// Stub heavy child components so the page-level test focuses on routing
// and URL filter state rather than rendering of message threads.
const stubs = {
  ConversationView: { template: '<div class="stub-conversation-view"><slot /></div>' },
  ContextPanel: { template: '<div class="stub-context-panel" />' },
  ConversationList: {
    props: ['items', 'activeId'],
    template:
      '<div class="stub-conversation-list">' +
      '<div v-for="i in items" :key="i.id" class="stub-item">{{ i?.contact?.channel?.title || i?.contact?.value || i.id }}</div>' +
      '</div>',
  },
  InboxFilters: { template: '<div class="stub-inbox-filters" />' },
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('InboxPage — URL filter state', () => {
  it('passes filter params from route.query to the /conversations request', async () => {
    routeState.value = {
      name: 'inbox',
      params: {},
      query: { campaignId: 'camp-1', status: 'active' },
    };
    mountWithApp(InboxPage, { global: { stubs } });
    await flushPromises();
    // The list call is `api.get('/conversations', { params: filters })`;
    // we assert on the params object, not the URL string.
    const conversationsCall = apiGet.mock.calls.find(
      (c) => c[0] === '/conversations' && c[1]?.params,
    );
    expect(conversationsCall).toBeTruthy();
    expect(conversationsCall![1].params).toMatchObject({
      campaignId: 'camp-1',
      status: 'active',
    });
  });

  it('auto-selects the first conversation via router.replace preserving query', async () => {
    routeState.value = { name: 'inbox', params: {}, query: { campaignId: 'camp-1' } };
    mountWithApp(InboxPage, { global: { stubs } });
    await flushPromises();
    // Auto-select must be a replace (not push) so it does not pollute
    // history; it must preserve the campaignId query.
    expect(routerReplace).toHaveBeenCalled();
    const arg = routerReplace.mock.calls[0]?.[0];
    expect(arg).toMatchObject({
      name: 'inbox-conversation',
      params: { conversationId: 'conv-1' },
      query: { campaignId: 'camp-1' },
    });
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('does not auto-select when the filtered list is empty', async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (path === '/conversations') return [];
      if (path === '/campaigns') return [];
      return [];
    });
    routeState.value = { name: 'inbox', params: {}, query: { campaignId: 'unknown' } };
    mountWithApp(InboxPage, { global: { stubs } });
    await flushPromises();
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it('clicking a conversation in the list preserves the active filters in the URL', async () => {
    routeState.value = {
      name: 'inbox-conversation',
      params: { conversationId: 'conv-1' },
      query: { campaignId: 'camp-1', q: 'acme' },
    };
    // Use a non-stubbed list so we can dispatch a real click on an item.
    const { wrapper } = mountWithApp(InboxPage, {
      global: {
        stubs: {
          ConversationView: { template: '<div />' },
          ContextPanel: { template: '<div />' },
          InboxFilters: { template: '<div />' },
          // Custom ConversationList that emits the pick event we want.
          ConversationList: {
            props: ['items', 'activeId'],
            emits: ['pick'],
            template:
              '<button class="pick-btn" @click="$emit(\'pick\', \'conv-2\')">pick</button>',
          },
        },
      },
    });
    await flushPromises();
    routerPush.mockReset(); // ignore any initial navigation
    await wrapper.get('.pick-btn').trigger('click');
    expect(routerPush).toHaveBeenCalledWith({
      name: 'inbox-conversation',
      params: { conversationId: 'conv-2' },
      query: expect.objectContaining({ campaignId: 'camp-1', q: 'acme' }),
    });
  });

  it('user filter change uses router.push (creates history entry), not replace', async () => {
    routeState.value = {
      name: 'inbox-conversation',
      params: { conversationId: 'conv-1' },
      query: {},
    };
    const { wrapper } = mountWithApp(InboxPage, {
      global: {
        stubs: {
          ConversationView: { template: '<div />' },
          ContextPanel: { template: '<div />' },
          ConversationList: { template: '<div />' },
          InboxFilters: {
            emits: ['update:modelValue'],
            template:
              '<button class="filter-btn" @click="$emit(\'update:modelValue\', { campaignId: \'camp-1\' })">filter</button>',
          },
        },
      },
    });
    await flushPromises();
    routerPush.mockReset();
    routerReplace.mockReset();
    await wrapper.get('.filter-btn').trigger('click');
    expect(routerPush).toHaveBeenCalled();
    expect(routerPush.mock.calls[0]?.[0]).toMatchObject({
      name: 'inbox-conversation',
      params: { conversationId: 'conv-1' },
      query: { campaignId: 'camp-1' },
    });
    // Crucially: it must NOT be a replace, otherwise back/forward skips
    // this state — spec scenario "Clearing a filter updates the URL and
    // creates history".
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it('renders the right pane from the details query when the selected conversation is outside the filtered list', async () => {
    routeState.value = {
      name: 'inbox-conversation',
      params: { conversationId: 'conv-X' },
      query: { campaignId: 'camp-1' },
    };
    const { wrapper } = mountWithApp(InboxPage, { global: { stubs } });
    await flushPromises();
    // The per-id detail query fires for conv-X, not the list item.
    const detailCall = apiGet.mock.calls.find(
      (c) => c[0] === '/conversations/conv-X',
    );
    expect(detailCall).toBeTruthy();
    // The (stubbed) ConversationView is rendered, meaning `current` is
    // non-null even though conv-X is not in the filtered list.
    expect(wrapper.find('.stub-conversation-view').exists()).toBe(true);
    // The "select a conversation" empty state must NOT appear.
    expect(wrapper.text()).not.toContain('Выберите диалог');
  });
});
