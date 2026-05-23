<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import ConversationList from './ConversationList.vue';
import ConversationView from './ConversationView.vue';
import ContextPanel from './ContextPanel.vue';
import EmptyState from '../../components/EmptyState.vue';
import { api } from '../../lib/api';
import type { ConversationListItem, Suggestion, ConversationDetail } from './types';

const route = useRoute();
const router = useRouter();

const showContext = ref(true);

const conversationId = computed(() => (route.params.conversationId as string | undefined) ?? undefined);

const { data: conversations } = useQuery({
  queryKey: ['conversations'],
  queryFn: () => api.get<ConversationListItem[]>('/conversations'),
  refetchInterval: 30_000,
});

const list = computed<ConversationListItem[]>(() => conversations.value ?? []);
const current = computed<ConversationListItem | null>(() => list.value.find((c) => c.id === conversationId.value) ?? null);

watch(
  [() => list.value, conversationId],
  ([items, id]) => {
    if (!id && items[0]) {
      router.replace(`/inbox/${items[0].id}`);
    }
  },
  { immediate: true },
);

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

function pick(id: string): void {
  router.push(`/inbox/${id}`);
}
</script>

<template>
  <div :style="{
    display: 'grid',
    gridTemplateColumns: showContext ? '320px 1fr 340px' : '320px 1fr',
    height: 'calc(100vh - var(--topbar))',
    minHeight: 0,
  }">
    <ConversationList :items="list" :active-id="conversationId" @pick="pick" />
    <template v-if="current">
      <ConversationView :conversation="current" :show-context="showContext" @toggle-context="showContext = !showContext" />
      <ContextPanel
        v-if="showContext && details"
        :conversation="details"
        :suggestions="contextSuggestions ?? []"
        @close="showContext = false"
      />
    </template>
    <template v-else>
      <div style="display: flex; align-items: center; justify-content: center; min-width: 0;">
        <EmptyState title="Выберите диалог" description="Слева — список входящих и исходящих CustDev-диалогов." icon="chat" />
      </div>
    </template>
  </div>
</template>
