<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import ConversationList from './ConversationList.vue';
import ConversationView from './ConversationView.vue';
import ContextPanel from './ContextPanel.vue';
import InboxFilters from './InboxFilters.vue';
import EmptyState from '../../components/EmptyState.vue';
import ConfirmDialog from '../../components/ConfirmDialog.vue';
import Icon from '../../components/Icon.vue';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { useAuth } from '../../lib/auth';
import { useRoom } from '../../lib/socket';
import type { ConversationListItem, Suggestion, ConversationDetail } from './types';
import {
  hasAnyFilter,
  mergeFilterQuery,
  parseInboxFilters,
  type InboxFilters as InboxFiltersT,
} from './filters';

const route = useRoute();
const router = useRouter();
const qc = useQueryClient();
const { user } = useAuth();

const showContext = ref(true);

// Conversation dedup: collapse a channel's duplicate threads to one. Any chat
// we already wrote to is kept; only never-contacted empty duplicates are
// removed. Admin/operator only (destructive maintenance action).
const canDedupe = computed(() => user.value?.role === 'admin' || user.value?.role === 'operator');
const showDedupeConfirm = ref(false);

const dedupe = useMutation({
  mutationFn: () =>
    api.post<{ scannedChannels: number; duplicateChannels: number; removed: number }>(
      '/conversations/dedupe',
    ),
  onSuccess: (r) => {
    showDedupeConfirm.value = false;
    if (r.removed > 0) {
      toast.success(
        `Убрано дублей: ${r.removed}`,
        `Каналов с дублями: ${r.duplicateChannels}. Чаты, где уже была переписка, сохранены.`,
      );
    } else {
      toast.info('Дублей не найдено', 'Каждый канал уже ведётся одним диалогом.');
    }
    qc.invalidateQueries({ queryKey: ['conversations'] });
    qc.invalidateQueries({ queryKey: ['conversation'] });
  },
  onError: (e: Error) => {
    showDedupeConfirm.value = false;
    toast.error('Не удалось дедуплицировать', e.message);
  },
});

const conversationId = computed(() => (route.params.conversationId as string | undefined) ?? undefined);
const filters = computed<InboxFiltersT>(() => parseInboxFilters(route.query));
const campaignRoom = computed(() =>
  filters.value.campaignId ? `campaign:${filters.value.campaignId}` : null,
);

const { data: conversations } = useQuery({
  // The queryKey carries the filter object so React Query re-fetches
  // whenever the URL filters change — single source of truth.
  queryKey: ['conversations', filters],
  queryFn: () => api.get<ConversationListItem[]>('/conversations', { params: { ...filters.value } }),
  refetchInterval: 5_000,
});

const list = computed<ConversationListItem[]>(() => conversations.value ?? []);

const { data: details } = useQuery({
  queryKey: ['conversation', conversationId],
  queryFn: () => api.get<ConversationDetail>(`/conversations/${conversationId.value}`),
  enabled: computed(() => !!conversationId.value),
});

const { data: contextSuggestions } = useQuery({
  queryKey: ['conversation-suggestions', conversationId],
  queryFn: () => api.get<Suggestion[]>(`/conversations/${conversationId.value}/suggestions`),
  enabled: computed(() => !!conversationId.value),
});

// The right-hand pane shows the selected conversation even when it's
// outside the active filter — Decision 4. `details` comes from a
// separate /conversations/:id query and is not constrained by filters.
const current = computed<ConversationListItem | ConversationDetail | null>(() => {
  const fromList = list.value.find((c) => c.id === conversationId.value);
  if (fromList) return fromList;
  return details.value ?? null;
});

watch(
  [() => list.value, conversationId, () => route.query],
  ([items, id, query]) => {
    // Auto-select the first item only when no conversation is currently
    // selected. Uses replace (not push) so back/forward navigation skips
    // the synthetic redirect. The current query is preserved so applied
    // filters survive the redirect — Decision 1 + Decision 4.
    if (!id && items[0]) {
      router.replace({
        name: 'inbox-conversation',
        params: { conversationId: items[0].id },
        query: { ...query },
      });
    }
  },
  { immediate: true },
);

function pick(id: string): void {
  // Preserve current filters when navigating to another conversation —
  // a plain `router.push('/inbox/<id>')` would drop them.
  router.push({
    name: 'inbox-conversation',
    params: { conversationId: id },
    query: { ...route.query },
  });
}

function updateFilters(patch: Partial<InboxFiltersT>): void {
  // User-initiated filter changes create a history entry so back/forward
  // navigate between filter states. Auto-navigation (above) uses replace.
  const nextQuery = mergeFilterQuery(route.query, patch);
  router.push({
    name: conversationId.value ? 'inbox-conversation' : 'inbox',
    params: conversationId.value ? { conversationId: conversationId.value } : {},
    query: nextQuery,
  });
}

const showEmpty = computed(() => list.value.length === 0 && hasAnyFilter(filters.value));

useRoom(() => campaignRoom.value, 'message.new', () => {
  qc.invalidateQueries({ queryKey: ['conversations'] });
});
</script>

<template>
  <div :style="{
    display: 'grid',
    gridTemplateColumns: showContext ? '320px 1fr 340px' : '320px 1fr',
    height: 'calc(100vh - var(--topbar))',
    minHeight: 0,
  }">
    <div style="display: flex; flex-direction: column; min-height: 0; height: 100%;">
      <InboxFilters
        :model-value="filters"
        @update:model-value="updateFilters"
      />
      <div
        v-if="canDedupe"
        style="display: flex; justify-content: flex-end; padding: 6px 10px; border-bottom: 1px solid var(--line); background: var(--paper-2);"
      >
        <button
          class="btn ghost sm"
          type="button"
          title="Убрать дублирующиеся диалоги по каналам. Чаты, где уже была переписка, сохраняются."
          :disabled="dedupe.isPending.value"
          @click="showDedupeConfirm = true"
        >
          <Icon name="layers" :size="11" />
          <span>Убрать дубли</span>
        </button>
      </div>
      <ConversationList :items="list" :active-id="conversationId" @pick="pick" />
    </div>
    <template v-if="current">
      <ConversationView
        :key="current.id"
        :conversation="current"
        :show-context="showContext"
        @toggle-context="showContext = !showContext"
      />
      <ContextPanel
        v-if="showContext && details"
        :conversation="details"
        :suggestions="contextSuggestions ?? []"
        @close="showContext = false"
      />
    </template>
    <template v-else>
      <div style="display: flex; align-items: center; justify-content: center; min-width: 0;">
        <EmptyState
          v-if="showEmpty"
          title="Под фильтр ничего не попало"
          description="Сбросьте фильтры или измените запрос, чтобы увидеть другие диалоги."
          icon="filter"
        />
        <EmptyState v-else title="Выберите диалог" description="Слева — список входящих и исходящих диалогов." icon="chat" />
      </div>
    </template>
  </div>

  <ConfirmDialog
    :open="showDedupeConfirm"
    title="Убрать дубли диалогов?"
    description="По каждому каналу останется один диалог. Чаты, где уже была переписка (входящие или исходящие), сохраняются — удаляются только пустые дубликаты, по которым ещё никто не писал."
    confirm-label="Убрать дубли"
    destructive
    :loading="dedupe.isPending.value"
    @close="showDedupeConfirm = false"
    @confirm="dedupe.mutate()"
  />
</template>
