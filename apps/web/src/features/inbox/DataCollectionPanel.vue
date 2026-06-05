<script setup lang="ts">
import { computed } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';

import Icon from '../../components/Icon.vue';
import { api } from '../../lib/api';
import { useFlags } from '../../lib/config';
import { isFeatureOff } from '../../lib/featureGate';
import { formatRelative } from '../../lib/format';
import { useRoom } from '../../lib/socket';

/**
 * Inbox right-panel HUD for agency-sourcing data collection
 * (data-collection-hud-target-fields change, Phase 1).
 *
 * Renders per-target state from `GET /conversations/:id/data-collection`,
 * keeps it patched in place via the `data_collection.updated` WS event,
 * and falls back to a 30s poll while visible. Returns `null` (renders
 * nothing) when the `data_collection_hud` runtime flag is off — the
 * endpoint 404s and `isFeatureOff` catches it.
 */

const props = defineProps<{
  conversationId: string;
}>();

interface HudCurrent {
  value: unknown;
  capturedAt: string;
  sourceMessageId?: string;
  sourceField: string;
}

interface HudTarget {
  key: string;
  label: string;
  description_for_operator: string;
  freshness_section: string;
  manual_only?: boolean;
  state: 'answered' | 'asked' | 'missing' | 'stale';
  current?: HudCurrent;
  lastAskedAt?: string;
  freshness?: { stale: boolean; ageDays: number | null };
}

interface HudResponse {
  campaignTypeKey: string | null;
  targets: HudTarget[];
}

const qc = useQueryClient();
const flags = useFlags();
const room = computed(() => `conversation:${props.conversationId}`);

const { data, error } = useQuery<HudResponse>({
  queryKey: ['conversation-data-collection', () => props.conversationId],
  queryFn: () =>
    api.get<HudResponse>(`/conversations/${props.conversationId}/data-collection`),
  // Never issue the request when the feature is off — the public /config
  // snapshot gates it, so no per-conversation 404 hits the console. The
  // isFeatureOff guard below stays as defense-in-depth for the race where the
  // flag flips between the /config fetch and navigation.
  enabled: () => flags.value.dataCollectionHud,
  // 30s poll covers any missed WS event (delivery is best-effort —
  // the flag-gated emitter early-returns when off, so consumers must
  // tolerate gaps).
  refetchInterval: 30_000,
  // Don't retry on 404 — that's the flag-off signal, not a transient
  // failure.
  retry: (failureCount, err) => !isFeatureOff(err) && failureCount < 2,
});

// Render nothing when the feature flag is off (server returns 404),
// the conversation has no campaign-resolved targets, or the response
// has not arrived yet.
const flagOff = computed(() => error.value && isFeatureOff(error.value));
const targets = computed<HudTarget[]>(() => data.value?.targets ?? []);
const show = computed(
  () => !flagOff.value && targets.value.length > 0,
);

// Subscribe to the per-target patch event and merge into the cached
// HUD response so the panel updates without a full re-fetch.
useRoom(() => room.value, 'data_collection.updated', (payload) => {
  qc.setQueryData<HudResponse | undefined>(
    ['conversation-data-collection', props.conversationId],
    (prev) => {
      if (!prev) return prev;
      const idx = prev.targets.findIndex((t) => t.key === payload.targetKey);
      if (idx < 0) return prev;
      const merged: HudTarget = {
        ...prev.targets[idx]!,
        state: payload.state,
        ...(payload.current ? { current: payload.current } : {}),
        ...(payload.freshness ? { freshness: payload.freshness } : {}),
        ...(payload.lastAskedAt ? { lastAskedAt: payload.lastAskedAt } : {}),
      };
      const next = prev.targets.slice();
      next[idx] = merged;
      return { ...prev, targets: next };
    },
  );
});

function stateLabel(state: HudTarget['state']): string {
  switch (state) {
    case 'answered':
      return 'есть';
    case 'asked':
      return 'спросили';
    case 'missing':
      return 'не хватает';
    case 'stale':
      return 'устарело';
  }
}

function stateColor(state: HudTarget['state']): string {
  switch (state) {
    case 'answered':
      return 'var(--good)';
    case 'asked':
      return 'var(--ink-3)';
    case 'missing':
      return 'var(--warn)';
    case 'stale':
      return 'var(--warn)';
  }
}

function formatValue(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'number') return new Intl.NumberFormat('ru-RU').format(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function freshnessLabel(target: HudTarget): string | null {
  if (!target.freshness) return null;
  const { ageDays, stale } = target.freshness;
  if (ageDays == null) return null;
  const ago = ageDays === 0 ? 'сегодня' : `${ageDays} дн назад`;
  return stale ? `устарело · ${ago}` : ago;
}

function jumpToMessage(messageId: string | undefined): void {
  if (!messageId) return;
  const el = document.querySelector(`[data-msg-id="${messageId}"]`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('hud-highlight');
    setTimeout(() => el.classList.remove('hud-highlight'), 1500);
  }
}

function draftQuestion(target: HudTarget): void {
  // Cross-component bus: ConversationView listens for `inbox:draft-request`
  // on the window. Lightweight alternative to a shared store; the panel
  // and the composer live in sibling trees so a CustomEvent is the
  // simplest correct path.
  window.dispatchEvent(
    new CustomEvent('inbox:draft-request', {
      detail: {
        conversationId: props.conversationId,
        text: target.description_for_operator,
      },
    }),
  );
}
</script>

<template>
  <div v-if="show" class="hud">
    <div class="hud-header">
      <Icon name="sparkle" :size="12" />
      <span>Сбор данных</span>
    </div>
    <ul class="hud-list">
      <li v-for="target in targets" :key="target.key" class="hud-row">
        <div class="hud-row-head">
          <span class="hud-label" :title="target.description_for_operator">{{ target.label }}</span>
          <span
            class="hud-badge"
            :style="{ color: stateColor(target.state), borderColor: stateColor(target.state) }"
          >
            {{ stateLabel(target.state) }}
          </span>
          <span v-if="target.manual_only" class="hud-tag" title="Без автокаптуры — вручную оператором">manual</span>
        </div>
        <div v-if="target.current" class="hud-current">
          <span class="hud-value mono">{{ formatValue(target.current.value) }}</span>
          <button
            v-if="target.current.sourceMessageId"
            class="btn ghost icon-only xs"
            :title="`Открыть исходное сообщение (${target.current.sourceField})`"
            @click="jumpToMessage(target.current.sourceMessageId)"
          >
            <Icon name="chat" :size="11" />
          </button>
        </div>
        <div v-if="freshnessLabel(target)" class="hud-fresh">
          {{ freshnessLabel(target) }}
        </div>
        <div v-else-if="target.lastAskedAt" class="hud-fresh">
          спросили {{ formatRelative(target.lastAskedAt) }}
        </div>
        <button
          v-if="target.state === 'missing' || target.state === 'stale'"
          class="btn ghost xs hud-draft"
          @click="draftQuestion(target)"
        >
          <Icon name="sparkle" :size="11" />
          <span>Задать вопрос</span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.hud {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--paper);
  padding: 10px 12px;
  margin-bottom: 12px;
}
.hud-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--ink-3);
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.hud-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.hud-row {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 6px 0;
  border-top: 1px solid var(--line);
}
.hud-row:first-child {
  border-top: none;
}
.hud-row-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.hud-label {
  flex: 1;
  font-size: 12px;
  color: var(--ink-1);
}
.hud-badge {
  border: 1px solid;
  border-radius: 999px;
  padding: 0 6px;
  font-size: 10px;
  text-transform: lowercase;
}
.hud-tag {
  font-size: 10px;
  color: var(--ink-3);
  border: 1px solid var(--line-2);
  border-radius: 999px;
  padding: 0 6px;
}
.hud-current {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--ink-2);
}
.hud-value {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hud-fresh {
  font-size: 10.5px;
  color: var(--ink-3);
}
.hud-draft {
  align-self: flex-start;
  margin-top: 2px;
}
</style>
