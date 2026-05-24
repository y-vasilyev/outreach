<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import PageHead from '../../components/PageHead.vue';
import Icon from '../../components/Icon.vue';
import Spinner from '../../components/Spinner.vue';
import Pill from '../../components/Pill.vue';
import EmptyState from '../../components/EmptyState.vue';
import Bar from '../../components/Bar.vue';
import FeatureOff from '../../components/FeatureOff.vue';
import { api, ApiError } from '../../lib/api';
import { isFeatureOff } from '../../lib/featureGate';
import { formatDateTime, formatNumber } from '../../lib/format';
import type { DiscoveryBatchStatus } from './types';
import { batchProgress, perQueryLabel, perQueryPill, pollInterval, statusPill } from './helpers';

const route = useRoute();
const router = useRouter();
const id = computed(() => route.params.id as string);

const { data, isLoading, error } = useQuery({
  queryKey: ['discovery-batch', id],
  queryFn: () => api.get<DiscoveryBatchStatus>(`/discovery/batch/${id.value}`),
  enabled: computed(() => !!id.value),
  refetchInterval: (q) =>
    pollInterval(q.state.data as DiscoveryBatchStatus | undefined, q.state.error),
  retry: false,
});

const featureOff = computed(() => isFeatureOff(error.value));
const notFound = computed(
  () => error.value instanceof ApiError && error.value.status === 404 && error.value.code === 'NOT_FOUND',
);

const totals = computed(() => data.value?.summary.totals);
const progress = computed(() => batchProgress(totals.value));

const stillRunning = computed(
  () => data.value != null && data.value.status !== 'done' && data.value.status !== 'failed',
);
</script>

<template>
  <PageHead
    :title="`Discovery batch · ${id.slice(0, 8)}…`"
    sub="Прогресс по нишам обновляется автоматически"
  >
    <template #actions>
      <button class="btn" @click="router.push('/discovery')">
        <Icon name="arrow_left" :size="12" /><span>К Discovery</span>
      </button>
    </template>
  </PageHead>

  <FeatureOff v-if="featureOff" flag="channel_discovery" />

  <EmptyState
    v-else-if="notFound"
    title="Batch не найден"
    description="Batch с таким id не существует или был удалён."
    icon="layers"
  >
    <template #action>
      <button class="btn" @click="router.push('/discovery')">
        <Icon name="arrow_left" :size="12" /><span>К Discovery</span>
      </button>
    </template>
  </EmptyState>

  <!-- Catch-all error state — without it a 403/500/network failure would
       render an infinite spinner (because `!data` stays true after a
       failed fetch). -->
  <EmptyState
    v-else-if="error"
    title="Ошибка загрузки batch"
    :description="error instanceof ApiError ? error.message : 'Неизвестная ошибка'"
    icon="warn"
  />

  <div v-else-if="isLoading || !data" class="center"><Spinner /></div>

  <!-- Single `.cards` wrapper — `.main` clips overflow, so a long per-query
       table (up to 50 rows) would otherwise lose page padding/scroll. -->
  <div v-else class="cards" style="grid-template-columns: 1fr;">
    <!-- Header card: status, timing, progress bar -->
    <div class="card">
      <div class="card-body" style="display: flex; flex-direction: column; gap: 10px;">
        <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
          <Pill :cls="statusPill(data.status)">{{ data.status }}</Pill>
          <span class="muted-2" style="font-size: 12px;">создан</span>
          <span class="mono" style="font-size: 12px;">{{ formatDateTime(data.createdAt) }}</span>
          <span v-if="data.completedAt" class="muted-2" style="font-size: 12px;">· завершён</span>
          <span v-if="data.completedAt" class="mono" style="font-size: 12px;">{{ formatDateTime(data.completedAt) }}</span>
          <span class="muted-2" style="font-size: 12px;">· платформа</span>
          <span class="mono" style="font-size: 12px;">{{ data.platform ?? 'all' }}</span>
          <span class="muted-2" style="font-size: 12px;">· лимит / ниша</span>
          <span class="mono" style="font-size: 12px;">{{ data.limitPerQuery }}</span>
          <span v-if="stillRunning" class="muted-2" style="font-size: 11px; margin-left: 4px;">
            <span class="spinner" /> обновляется
          </span>
        </div>

        <div style="display: flex; align-items: center; gap: 10px;">
          <Bar :value="progress" :width="240" tone="ok" />
          <span class="mono" style="font-size: 12px;">
            {{ formatNumber(totals?.processed ?? 0) }} / {{ formatNumber(totals?.queries ?? 0) }} ниш
          </span>
        </div>

        <div v-if="data.summary.fatalError" class="card" style="background: var(--bad-bg); border-color: var(--bad-line); padding: 10px 12px;">
          <div style="font-size: 12px; color: var(--bad);">
            <Icon name="warn" :size="12" /> Fatal: {{ data.summary.fatalError }}
          </div>
        </div>
      </div>
    </div>

    <!-- Totals -->
    <div class="card">
      <div class="card-head"><Icon name="trend" :size="12" /><span>Totals</span></div>
      <div class="card-body" style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px;">
        <div v-for="t in [
          { l: 'Ниш', v: totals?.queries ?? 0, color: '' },
          { l: 'Обработано', v: totals?.processed ?? 0, color: '' },
          { l: 'Новых каналов', v: totals?.created ?? 0, color: 'var(--ok)' },
          { l: 'Знаем', v: totals?.alreadyKnown ?? 0, color: '' },
          { l: 'С ошибкой', v: totals?.errored ?? 0, color: (totals?.errored ?? 0) > 0 ? 'var(--bad)' : '' },
        ]" :key="t.l">
          <div class="muted-2" style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;">{{ t.l }}</div>
          <div :style="{ fontSize: '18px', fontWeight: 600, fontFamily: 'var(--font-mono)', color: t.color || 'var(--ink)' }">
            {{ formatNumber(t.v) }}
          </div>
        </div>
      </div>
    </div>

    <!-- Per-query progress -->
    <div class="card">
      <div class="card-head">
        <Icon name="list" :size="12" /><span>По нишам ({{ data.summary.queries.length }})</span>
      </div>
      <div class="card-body">
        <div v-if="!data.summary.queries.length" class="placeholder" style="min-height: 48px;">
          Worker ещё не получил список ниш.
        </div>
        <table v-else class="tbl">
          <thead>
            <tr>
              <th>Ниша</th>
              <th>Статус</th>
              <th class="num">Кандидатов</th>
              <th class="num">Новых</th>
              <th class="num">Знаем</th>
              <th>Ошибка</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(q, i) in data.summary.queries" :key="i">
              <td class="cell-strong">{{ q.query }}</td>
              <td><Pill :cls="perQueryPill(q)">{{ perQueryLabel(q) }}</Pill></td>
              <td class="num mono">{{ formatNumber(q.candidates.length) }}</td>
              <td class="num mono" style="color: var(--ok);">{{ formatNumber(q.created) }}</td>
              <td class="num mono">{{ formatNumber(q.alreadyKnown) }}</td>
              <td>
                <span v-if="q.error" class="muted" style="font-size: 11.5px; color: var(--bad);">{{ q.error }}</span>
                <span v-else class="muted-2">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
