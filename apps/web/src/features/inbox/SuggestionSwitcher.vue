<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Icon from '../../components/Icon.vue';
import ConfBar from '../../components/ConfBar.vue';
import type { Suggestion } from './types';

const props = defineProps<{
  suggestions: Suggestion[];
  loading?: boolean;
}>();

const emit = defineEmits<{
  (e: 'sendAsIs', s: Suggestion): void;
  (e: 'edit', s: Suggestion): void;
  (e: 'reject', s: Suggestion): void;
  (e: 'feedback', payload: { s: Suggestion; up: boolean }): void;
}>();

const pending = computed(() => props.suggestions.filter((s) => s.status === 'pending').slice(0, 3));
const chosenId = ref<string | null>(null);

watch(
  () => pending.value.map((s) => s.id).join('|'),
  () => {
    if (!pending.value.length) chosenId.value = null;
    else if (!chosenId.value || !pending.value.find((s) => s.id === chosenId.value)) {
      chosenId.value = pending.value[0]!.id;
    }
  },
  { immediate: true },
);

const current = computed(() => pending.value.find((s) => s.id === chosenId.value) ?? pending.value[0] ?? null);

function score(s: Suggestion): number {
  // Map score 0..1; if absent, derive from risk_score (lower risk = higher confidence).
  if (typeof s.score === 'number') return s.score;
  const r = s.meta?.risk_score;
  if (typeof r === 'number') return Math.max(0, 1 - r);
  return 0.7;
}

function tone(s: Suggestion): string {
  const v = score(s);
  return v > 0.8 ? 'CustDev' : v > 0.6 ? 'CustDev / нейтр.' : 'CustDev / sharp';
}
</script>

<template>
  <div style="padding: 10px 14px; border-top: 1px solid var(--line); background: var(--paper-2); flex: none;">
    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 11.5px; color: var(--ink-3); flex-wrap: wrap;">
      <span style="color: var(--accent-2); display: inline-flex;"><Icon name="sparkle" :size="12" /></span>
      <span style="font-weight: 500; color: var(--ink-2);">Подсказки ИИ</span>
      <span class="muted-2" style="font-size: 10.5px;">{{ current?.agentName || 'ReplyComposer' }}</span>
      <div style="flex: 1;" />
      <span class="kbd">Tab</span>
      <span class="muted-2">принять</span>
    </div>

    <div v-if="loading" class="placeholder" style="min-height: 60px;">Готовим варианты…</div>

    <div v-else-if="pending.length === 0" class="placeholder" style="min-height: 60px;">
      Сейчас нет активных подсказок от ИИ. Напишите ответ сами или дождитесь нового сообщения.
    </div>

    <template v-else>
      <div
        style="display: flex; gap: 0; margin-bottom: 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--paper); padding: 2px;"
      >
        <button
          v-for="(s, i) in pending"
          :key="s.id"
          type="button"
          :style="{
            flex: 1,
            height: '26px',
            border: 'none',
            background: s.id === chosenId ? 'var(--paper-3)' : 'transparent',
            borderRadius: '4px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px',
            fontSize: '11.5px',
            color: s.id === chosenId ? 'var(--ink)' : 'var(--ink-3)',
            fontWeight: s.id === chosenId ? 500 : 400,
            minWidth: 0,
            padding: '0 8px',
          }"
          @click="chosenId = s.id"
        >
          <span class="mono" style="font-size: 10px; color: var(--ink-4);">#{{ i + 1 }}</span>
          <span class="ellipsis">{{ (s.meta?.length || s.meta?.intent_target || 'вариант') }}</span>
          <ConfBar :value="score(s)" />
        </button>
      </div>

      <div
        v-if="current"
        style="border: 1px solid var(--accent-line); background: var(--accent-bg); border-radius: 7px; padding: 10px;"
      >
        <div style="font-size: 12px; color: var(--ink-2); line-height: 1.5; white-space: pre-wrap;">{{ current.text }}</div>
        <div v-if="current.rationale" class="muted-2" style="margin-top: 6px; font-size: 10.5px; font-style: italic;">{{ current.rationale }}</div>
        <div style="display: flex; gap: 4px; margin-top: 8px; align-items: center; flex-wrap: wrap;">
          <span class="muted-2" style="font-size: 10.5px;">
            conf <span class="mono">{{ Math.round(score(current) * 100) }}</span> · {{ tone(current) }}
          </span>
          <div style="flex: 1;" />
          <button class="btn ghost icon-only sm" title="👍" @click="emit('feedback', { s: current!, up: true })">
            <Icon name="thumbs_up" :size="11" />
          </button>
          <button class="btn ghost icon-only sm" title="👎" @click="emit('feedback', { s: current!, up: false })">
            <Icon name="thumbs_down" :size="11" />
          </button>
          <button class="btn sm" @click="emit('edit', current!)">
            <Icon name="edit" :size="11" /><span>В черновик</span>
          </button>
          <button class="btn sm" @click="emit('reject', current!)" title="Отклонить">
            <Icon name="x" :size="11" />
          </button>
          <button class="btn primary sm" @click="emit('sendAsIs', current!)">
            <Icon name="send" :size="11" /><span>Отправить</span>
          </button>
        </div>
      </div>
    </template>
  </div>
</template>
