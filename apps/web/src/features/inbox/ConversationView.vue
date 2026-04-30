<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import Avatar from '../../components/Avatar.vue';
import Tag from '../../components/Tag.vue';
import Pill from '../../components/Pill.vue';
import Icon from '../../components/Icon.vue';
import Spinner from '../../components/Spinner.vue';
import Dropdown from '../../components/Dropdown.vue';
import MessageBubble from './MessageBubble.vue';
import SuggestionStrip from './SuggestionStrip.vue';
import { useRoom } from '../../lib/socket';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { initials, formatRelative } from '../../lib/format';
import { avatarColor } from '../../lib/state';
import type { ChatMessage, ConversationDetail, ConversationListItem, Suggestion } from './types';

const props = defineProps<{
  conversation: ConversationListItem;
  showContext: boolean;
}>();

const emit = defineEmits<{ (e: 'toggleContext'): void }>();

const cId = computed(() => props.conversation.id);
const room = computed(() => `conversation:${cId.value}`);
const qc = useQueryClient();

const { data: details } = useQuery({
  queryKey: ['conversation', cId],
  queryFn: () => api.get<ConversationDetail>(`/conversations/${cId.value}`),
});

// Fall back to a short refetchInterval even though we also subscribe to
// `message.new` over Socket.IO. In dev (and through some prod proxies)
// the realtime channel can stall — without polling the open thread sits
// stale until the operator reloads. 4s is short enough to feel live and
// long enough not to spam the API.
const { data: messages, isLoading: msgsLoading } = useQuery({
  queryKey: ['conversation-messages', cId],
  queryFn: () => api.get<ChatMessage[]>(`/conversations/${cId.value}/messages`),
  refetchInterval: 4_000,
});

const { data: suggestions } = useQuery({
  queryKey: ['conversation-suggestions', cId],
  queryFn: () => api.get<Suggestion[]>(`/conversations/${cId.value}/suggestions`),
  refetchInterval: 4_000,
});

const draft = ref('');
const scrollRef = ref<HTMLElement | null>(null);

useRoom(() => room.value, 'message.new', () => {
  qc.invalidateQueries({ queryKey: ['conversation-messages', cId.value] });
  qc.invalidateQueries({ queryKey: ['conversations'] });
});
useRoom(() => room.value, 'suggestion.new', () => {
  qc.invalidateQueries({ queryKey: ['conversation-suggestions', cId.value] });
});
useRoom(() => room.value, 'mode.changed', () => {
  qc.invalidateQueries({ queryKey: ['conversation', cId.value] });
});

watch(
  () => messages.value?.length,
  () => {
    nextTick(() => {
      if (scrollRef.value) scrollRef.value.scrollTop = scrollRef.value.scrollHeight;
    });
  },
);

watch(cId, () => { draft.value = ''; });

const c = computed<ConversationDetail>(() => details.value ?? (props.conversation as ConversationDetail));
const handle = computed(() => c.value.contact?.channel?.handle ?? c.value.contact?.value ?? '—');
const title = computed(() => c.value.contact?.channel?.title ?? c.value.contact?.value ?? 'Без названия');

const modeMut = useMutation({
  mutationFn: (mode: 'auto' | 'assisted' | 'manual') =>
    api.patch<void>(`/conversations/${cId.value}`, { mode }),
  onSuccess: (_v, mode) => {
    qc.invalidateQueries({ queryKey: ['conversation', cId.value] });
    qc.invalidateQueries({ queryKey: ['conversations'] });
    toast.success(`Режим: ${mode}`);
  },
});

const statusMut = useMutation({
  mutationFn: (status: 'active' | 'paused' | 'done' | 'failed') =>
    api.patch<void>(`/conversations/${cId.value}`, { status }),
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: ['conversation', cId.value] });
    qc.invalidateQueries({ queryKey: ['conversations'] });
  },
});

const sendMut = useMutation({
  mutationFn: () => api.post<void>(`/conversations/${cId.value}/messages`, { text: draft.value }),
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: ['conversation-messages', cId.value] });
    draft.value = '';
    toast.success('Сообщение поставлено в очередь');
  },
  onError: (e: Error) => toast.error('Не удалось отправить', e.message),
});

interface DayGroup { day: string; items: ChatMessage[] }

const groupedMessages = computed<DayGroup[]>(() => {
  const list = messages.value ?? [];
  const fmt = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' });
  const map = new Map<string, ChatMessage[]>();
  for (const m of list) {
    const d = new Date(m.createdAt);
    const key = Number.isNaN(d.getTime()) ? 'без даты' : fmt.format(d);
    const arr = map.get(key);
    if (arr) arr.push(m); else map.set(key, [m]);
  }
  return Array.from(map.entries()).map(([day, items]) => ({ day, items }));
});

const dropdownItems = computed(() => [
  { label: 'Режим: auto', icon: 'play_circle' as const, onClick: () => modeMut.mutate('auto') },
  { label: 'Режим: assisted', icon: 'sparkle' as const, onClick: () => modeMut.mutate('assisted') },
  { label: 'Режим: manual', icon: 'user' as const, onClick: () => modeMut.mutate('manual') },
  { divider: true, label: '' },
  { label: 'Поставить на паузу', icon: 'pause_circle' as const, onClick: () => statusMut.mutate('paused') },
  { label: 'Закрыть как done', icon: 'check_circle' as const, onClick: () => statusMut.mutate('done') },
]);

function send(): void {
  if (draft.value.trim().length === 0) return;
  sendMut.mutate();
}

function onComposerKey(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); }
}

function escalate(): void { modeMut.mutate('manual'); }

/**
 * Re-trigger AI suggestion generation. Useful when prior runs returned
 * no usable suggestions (e.g. SafetyFilter blocked everything) or when
 * the operator wants a fresh batch with a different agent config.
 */
const regenerateMut = useMutation({
  mutationFn: () =>
    api.post<{ ok: true; pipeline: 'on_inbound' | 'outreach_first_message'; expiredCount: number }>(
      `/conversations/${cId.value}/regenerate-suggestions`,
      {},
    ),
  onSuccess: (r) => {
    qc.invalidateQueries({ queryKey: ['conversation-suggestions', cId.value] });
    toast.info(
      r.pipeline === 'on_inbound' ? 'Reply suggestions в очереди' : 'Opening suggestions в очереди',
      r.expiredCount > 0 ? `Старых подсказок отменено: ${r.expiredCount}` : undefined,
    );
  },
  onError: (e: Error) => toast.error('Не удалось перегенерировать', e.message),
});

useRoom(() => room.value, 'suggestion.approved', () => {
  qc.invalidateQueries({ queryKey: ['conversation-suggestions', cId.value] });
  qc.invalidateQueries({ queryKey: ['conversation-messages', cId.value] });
});
</script>

<template>
  <div style="display: flex; flex-direction: column; min-height: 0; min-width: 0; height: 100%;">
    <!-- Header -->
    <div style="height: var(--topbar); padding: 0 16px; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--line); flex: none;">
      <Avatar :text="initials(title)" size="lg" :color="avatarColor(c.id)" />
      <div style="min-width: 0;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-weight: 600; font-size: 13px;" class="ellipsis">{{ title }}</span>
          <Tag v-if="c.contact?.channel?.platform" :platform="c.contact.channel.platform" />
          <span class="mono muted-2">{{ handle }}</span>
        </div>
        <div v-if="c.contact?.channel" style="font-size: 11px; color: var(--ink-3); margin-top: 1px;" class="ellipsis">
          {{ c.contact.channel.title }} · {{ c.contact.channel.platform }}
        </div>
      </div>
      <div style="flex: 1;" />
      <Pill :state="c.status" />
      <Pill :state="c.mode" />
      <span class="divider-v" />
      <button
        class="btn ghost sm"
        :disabled="regenerateMut.isPending.value"
        @click="regenerateMut.mutate()"
        title="Сгенерировать AI-подсказки заново"
      >
        <span v-if="regenerateMut.isPending.value" class="spinner" />
        <Icon v-else name="sparkle" :size="12" />
        <span>Подсказки</span>
      </button>
      <button class="btn ghost sm" @click="escalate" title="Эскалация на оператора">
        <Icon name="flag" :size="12" /><span>Эскалация</span>
      </button>
      <button class="btn ghost icon-only sm" :title="showContext ? 'Скрыть контекст' : 'Показать контекст'" @click="emit('toggleContext')">
        <Icon name="eye" :size="12" />
      </button>
      <Dropdown :items="dropdownItems" align="right">
        <button class="btn ghost icon-only sm"><Icon name="more" :size="12" /></button>
      </Dropdown>
    </div>

    <!-- Messages -->
    <div ref="scrollRef" style="flex: 1; overflow: auto; padding: 18px 22px; background: var(--paper);">
      <div v-if="c.campaign" style="display: flex; justify-content: center; margin-bottom: 14px;">
        <span style="font-size: 10.5px; color: var(--ink-4); font-family: var(--font-mono); padding: 2px 9px; background: var(--paper-3); border: 1px solid var(--line); border-radius: 999px;">
          кампания: {{ c.campaign.name }}
        </span>
      </div>

      <div v-if="msgsLoading" class="center"><Spinner /></div>
      <div v-else-if="!messages || messages.length === 0" style="max-width: 360px; margin: 32px auto; text-align: center; color: var(--ink-3); font-size: 12.5px;">
        В диалоге пока нет сообщений. Когда придёт первое — оно появится здесь.
      </div>
      <template v-else>
        <div v-for="g in groupedMessages" :key="g.day" style="margin-bottom: 8px;">
          <div style="display: flex; justify-content: center; margin: 4px 0 12px;">
            <span style="font-size: 10.5px; color: var(--ink-4); font-family: var(--font-mono); padding: 2px 9px; background: var(--paper-3); border: 1px solid var(--line); border-radius: 999px;">{{ g.day }}</span>
          </div>
          <MessageBubble v-for="m in g.items" :key="m.id" :msg="m" />
        </div>
      </template>
    </div>

    <!-- Summary banner -->
    <div v-if="c.summary" style="border-top: 1px solid var(--line); background: var(--warn-bg); color: var(--warn); padding: 6px 14px; font-size: 11.5px;">
      <strong>Summary:</strong> {{ c.summary }}
    </div>

    <!-- Suggestions -->
    <SuggestionStrip
      :conversation-id="cId"
      :suggestions="suggestions ?? []"
      @pick-to-draft="(t) => (draft = t)"
    />

    <!-- Composer -->
    <div style="padding: 10px 14px 14px; border-top: 1px solid var(--line); background: var(--paper); flex: none;">
      <div style="border: 1px solid var(--line-2); border-radius: 8px; background: var(--paper); overflow: hidden; box-shadow: var(--shadow-sm);">
        <textarea
          v-model="draft"
          @keydown="onComposerKey"
          placeholder="Напиши ответ или выбери подсказку выше · ⌘↩ — отправить"
          style="width: 100%; min-height: 78px; resize: vertical; border: none; outline: none; padding: 10px 12px; font-family: inherit; font-size: 13px; color: var(--ink); background: transparent; line-height: 1.5;"
        />
        <div style="display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-top: 1px solid var(--line); background: var(--paper-2); flex-wrap: wrap;">
          <button class="btn ghost icon-only sm"><Icon name="paperclip" :size="12" /></button>
          <button class="btn ghost icon-only sm"><Icon name="smile" :size="12" /></button>
          <span class="divider-v" />
          <button class="btn ghost sm" title="Перефразировать"><Icon name="sparkle" :size="12" /></button>
          <button class="btn ghost sm" title="SafetyFilter"><Icon name="shield" :size="12" /></button>
          <div style="flex: 1; min-width: 8px;" />
          <button class="btn primary sm" :disabled="sendMut.isPending.value || !draft.trim()" @click="send">
            <Icon name="send" :size="11" /><span>Отправить</span><span class="kbd">⌘↩</span>
          </button>
        </div>
        <div v-if="c.tgAccount" style="padding: 0 10px 6px; display: flex; justify-content: flex-end;">
          <span class="muted-2" style="font-size: 10.5px;">с аккаунта <span class="mono">{{ c.tgAccount.label }}</span></span>
        </div>
      </div>
      <div v-if="c.lastInboundAt" style="display: none;">last inbound: {{ formatRelative(c.lastInboundAt) }}</div>
    </div>
  </div>
</template>
