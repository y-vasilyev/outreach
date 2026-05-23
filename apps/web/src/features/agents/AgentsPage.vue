<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { useRouter } from 'vue-router';
import PageHead from '../../components/PageHead.vue';
import Pill from '../../components/Pill.vue';
import Icon from '../../components/Icon.vue';
import Spinner from '../../components/Spinner.vue';
import EmptyState from '../../components/EmptyState.vue';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { AGENT_CLASS, AGENT_LABELS, type AgentSummary } from './types';

const router = useRouter();

const { data, isLoading } = useQuery({
  queryKey: ['agents'],
  queryFn: () => api.get<AgentSummary[]>('/agents'),
});

const list = computed<AgentSummary[]>(() => data.value ?? []);

function clsLabel(name: string): 'ok' | 'accent' | 'ghost' {
  const c = AGENT_CLASS[name];
  return c === 'strong' ? 'accent' : c === 'medium' ? 'ok' : 'ghost';
}
</script>

<template>
  <PageHead title="Агенты" :sub="`${list.length} агентов · конфиги промптов и параметров`">
    <template #actions>
      <button class="btn"><Icon name="upload" :size="12" /><span>Экспорт конфигов</span></button>
      <button class="btn primary"><Icon name="plus" :size="12" /><span>Новый агент</span></button>
    </template>
  </PageHead>

  <div v-if="isLoading" class="center"><Spinner /></div>
  <EmptyState
    v-else-if="list.length === 0"
    title="Агентов нет"
    description="Сидер должен заполнить agent_config дефолтами при первом запуске."
    icon="bot"
  />
  <div v-else class="cards" style="grid-template-columns: 1fr 1fr 1fr;">
    <div
      v-for="a in list"
      :key="a.id"
      class="card"
      style="cursor: pointer;"
      @click="router.push(`/agents/${a.id}`)"
    >
      <div class="card-head">
        <span style="display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 5px; background: var(--accent-bg); color: var(--accent-2);">
          <Icon name="bot" :size="12" />
        </span>
        <div style="flex: 1; min-width: 0;">
          <div class="cell-strong ellipsis">{{ AGENT_LABELS[a.name] ?? a.name }}</div>
          <div class="mono muted-2 ellipsis" style="font-size: 10.5px;">{{ a.name }}</div>
        </div>
        <Pill :cls="clsLabel(a.name)" :label="AGENT_CLASS[a.name] ?? '—'" :dot="false" />
      </div>
      <div class="card-body">
        <p class="muted" style="font-size: 12px; margin: 0 0 10px; line-height: 1.5; min-height: 32px;">{{ a.description ?? a.role ?? 'Без описания.' }}</p>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px;">
          <div style="background: var(--paper-2); border: 1px solid var(--line); padding: 6px 9px; border-radius: var(--r-sm);">
            <div class="muted-2" style="font-size: 10px; text-transform: uppercase;">Endpoint</div>
            <div class="ellipsis" style="font-size: 11.5px;">{{ a.endpoint?.name ?? '—' }}</div>
          </div>
          <div style="background: var(--paper-2); border: 1px solid var(--line); padding: 6px 9px; border-radius: var(--r-sm);">
            <div class="muted-2" style="font-size: 10px; text-transform: uppercase;">Модель</div>
            <div class="mono ellipsis" style="font-size: 11px;">{{ a.model }}</div>
          </div>
          <div style="background: var(--paper-2); border: 1px solid var(--line); padding: 6px 9px; border-radius: var(--r-sm);">
            <div class="muted-2" style="font-size: 10px; text-transform: uppercase;">Fallback</div>
            <div class="ellipsis" style="font-size: 11.5px;">{{ a.fallbackEndpoint?.name ?? '—' }}</div>
          </div>
          <div style="background: var(--paper-2); border: 1px solid var(--line); padding: 6px 9px; border-radius: var(--r-sm);">
            <div class="muted-2" style="font-size: 10px; text-transform: uppercase;">Версия</div>
            <div class="mono" style="font-size: 12px;">v{{ a.version }}</div>
          </div>
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; padding-top: 8px; margin-top: 10px; border-top: 1px solid var(--line); font-size: 11px; color: var(--ink-3);">
          <div style="display: inline-flex; align-items: center; gap: 6px;">
            <span :style="{ width: '6px', height: '6px', borderRadius: '50%', background: a.enabled ? 'var(--ok)' : 'var(--ink-4)' }" />
            <span>{{ a.enabled ? 'enabled' : 'disabled' }}</span>
            <span class="muted-2">·</span>
            <span class="mono">upd {{ formatDateTime(a.updatedAt) }}</span>
          </div>
          <span style="color: var(--accent-2); display: inline-flex; align-items: center; gap: 4px;">Открыть <Icon name="arrow_right" :size="11" /></span>
        </div>
      </div>
    </div>
  </div>
</template>
