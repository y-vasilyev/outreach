<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import Icon from '../../components/Icon.vue';
import ConfBar from '../../components/ConfBar.vue';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import type { Suggestion } from './types';

const props = defineProps<{
  conversationId: string;
  suggestions: Suggestion[];
}>();

const emit = defineEmits<{ (e: 'pickToDraft', text: string): void }>();

const qc = useQueryClient();
const chosenId = ref<string | null>(null);
const scheduledLocal = ref('');

const pending = computed(() => props.suggestions.filter((s) => s.status === 'pending').slice(0, 3));
const current = computed(() => {
  if (chosenId.value) return pending.value.find((s) => s.id === chosenId.value) ?? pending.value[0];
  return pending.value[0];
});

watch(
  () => props.conversationId,
  () => { chosenId.value = null; },
);

const approveMut = useMutation({
  mutationFn: ({ id, text, scheduledAt }: { id: string; text?: string; scheduledAt?: string }) =>
    api.post<void>(
      `/conversations/${props.conversationId}/suggestions/${id}/approve`,
      { ...(text ? { text } : {}), ...(scheduledAt ? { scheduledAt } : {}) },
    ),
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: ['conversation-messages', props.conversationId] });
    qc.invalidateQueries({ queryKey: ['conversation-suggestions', props.conversationId] });
    qc.invalidateQueries({ queryKey: ['conversations'] });
    scheduledLocal.value = '';
    toast.success('Сообщение поставлено в очередь отправки');
  },
  onError: (e: Error) => toast.error('Не удалось одобрить', e.message),
});

const rejectMut = useMutation({
  mutationFn: (id: string) => api.post<void>(`/conversations/${props.conversationId}/suggestions/${id}/reject`, {}),
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: ['conversation-suggestions', props.conversationId] });
    toast.info('Подсказка отклонена');
  },
});

function pick(id: string): void {
  chosenId.value = id;
}

function loadToDraft(): void {
  if (current.value) emit('pickToDraft', current.value.text);
}

function scheduledIso(): string | undefined {
  if (!scheduledLocal.value) return undefined;
  const d = new Date(scheduledLocal.value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function pickConf(s: Suggestion): number {
  return s.meta?.confidence ?? s.score ?? 0.7;
}

function tone(s: Suggestion): string {
  const c = pickConf(s);
  return c > 0.85 ? 'ok' : c > 0.65 ? '' : 'warn';
}
</script>

<template>
  <div v-if="pending.length > 0" style="padding: 10px 14px; border-top: 1px solid var(--line); background: var(--paper-2); flex: none;">
    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 11.5px; color: var(--ink-3); flex-wrap: wrap;">
      <span style="color: var(--accent-2); display: inline-flex;"><Icon name="sparkle" :size="12" /></span>
      <span style="font-weight: 500; color: var(--ink-2);">Подсказки ИИ</span>
      <span class="muted-2" style="font-size: 10.5px;">{{ current?.agentName || 'ReplyComposer' }}</span>
      <div style="flex: 1;" />
      <span class="kbd">Tab</span>
      <span class="muted-2">принять</span>
    </div>
    <div style="display: flex; gap: 0; margin-bottom: 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--paper); padding: 2px;">
      <button
        v-for="(s, i) in pending"
        :key="s.id"
        @click="pick(s.id)"
        :style="{
          flex: 1,
          height: '26px',
          border: 'none',
          background: current && current.id === s.id ? 'var(--paper-3)' : 'transparent',
          borderRadius: '4px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '6px',
          fontSize: '11.5px',
          color: current && current.id === s.id ? 'var(--ink)' : 'var(--ink-3)',
          fontWeight: current && current.id === s.id ? 500 : 400,
          minWidth: 0,
          padding: '0 8px',
        }"
      >
        <span class="mono" style="font-size: 10px; color: var(--ink-4);">#{{ i + 1 }}</span>
        <span class="ellipsis">{{ s.meta?.label || s.agentName }}</span>
        <ConfBar :value="pickConf(s)" />
      </button>
    </div>
    <div v-if="current" style="border: 1px solid var(--accent-line); background: var(--accent-bg); border-radius: 7px; padding: 10px;">
      <div style="font-size: 12px; color: var(--ink-2); line-height: 1.5; white-space: pre-wrap;">{{ current.text }}</div>
      <div style="display: flex; gap: 4px; margin-top: 8px; align-items: center; flex-wrap: wrap;">
        <span class="muted-2" style="font-size: 10.5px;">
          conf <span class="mono">{{ (pickConf(current) * 100).toFixed(0) }}</span>
          <template v-if="current.meta?.tone"> · {{ current.meta.tone }}</template>
          <template v-if="current.rationale"> · {{ current.rationale }}</template>
        </span>
        <div style="flex: 1;" />
        <button class="btn ghost icon-only sm" title="👍"><Icon name="thumbs_up" :size="11" /></button>
        <button class="btn ghost icon-only sm" title="👎" @click="rejectMut.mutate(current.id)"><Icon name="thumbs_down" :size="11" /></button>
        <button class="btn sm" @click="loadToDraft">
          <Icon name="edit" :size="11" /><span>В черновик</span>
        </button>
        <input
          class="input"
          type="datetime-local"
          v-model="scheduledLocal"
          title="Запланировать отправку"
          style="height: 28px; width: 170px; font-size: 11px;"
        />
        <button
          class="btn primary sm"
          :disabled="approveMut.isPending.value"
          @click="approveMut.mutate({ id: current.id, scheduledAt: scheduledIso() })"
        >
          <Icon name="send" :size="11" /><span>Отправить</span>
        </button>
      </div>
    </div>
  </div>
</template>
