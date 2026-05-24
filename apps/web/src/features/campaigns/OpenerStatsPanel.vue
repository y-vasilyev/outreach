<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import Icon from '../../components/Icon.vue';
import Tabs, { type TabItem } from '../../components/Tabs.vue';
import Bar from '../../components/Bar.vue';
import Spinner from '../../components/Spinner.vue';
import { api } from '../../lib/api';
import { formatNumber, formatPct } from '../../lib/format';
import type { OpenerStatsRow } from './types';

const props = defineProps<{ campaignId: string }>();

// Preset reply windows in hours. Backend default is 48h; max is 720h (30d).
// Keep this list tight — operators picking arbitrary windows is a slippery
// slope toward reading early outreach conversion as long-funnel attribution
// (see opener-stats.ts JSDoc).
const WINDOWS: TabItem[] = [
  { id: '24', label: '24 ч' },
  { id: '48', label: '48 ч' },
  { id: '168', label: '7 д' },
  { id: '720', label: '30 д' },
];

const windowHours = ref<string>('48');

const { data, isLoading, isFetching, error } = useQuery({
  queryKey: ['opener-stats', computed(() => props.campaignId), windowHours],
  queryFn: () =>
    api.get<OpenerStatsRow[]>(`/campaigns/${props.campaignId}/opener-stats?withinHours=${windowHours.value}`),
  enabled: computed(() => !!props.campaignId),
  // Stats are read-only and cheap; refetch on window swap, not on focus.
  refetchOnWindowFocus: false,
});

// Sort by replyRate desc (best on top). Tie-breaks: sent desc for stable
// ordering at equal rates (does NOT correct for small-sample noise — a
// 1/1 = 100% variant still ranks above 18/42 ≈ 42%), then variantKey asc
// for deterministic output across reloads.
const rows = computed<OpenerStatsRow[]>(() => {
  const r = data.value ?? [];
  return [...r].sort((a, b) => {
    if (b.replyRate !== a.replyRate) return b.replyRate - a.replyRate;
    if (b.sent !== a.sent) return b.sent - a.sent;
    return a.variantKey.localeCompare(b.variantKey);
  });
});

const totals = computed(() => {
  let sent = 0;
  let replied = 0;
  for (const r of rows.value) {
    sent += r.sent;
    replied += r.replied;
  }
  return { sent, replied, rate: sent > 0 ? replied / sent : 0 };
});

const showSpinner = computed(() => isLoading.value || isFetching.value);
</script>

<template>
  <div class="card">
    <div class="card-head">
      <Icon name="trend" :size="12" />
      <span>Опенер-варианты</span>
      <span class="muted-2">ответ в окне после отправки</span>
      <div class="actions">
        <Tabs :tabs="WINDOWS" :active="windowHours" @change="(id) => (windowHours = id)" />
      </div>
    </div>
    <div class="card-body">
      <div v-if="error" class="muted-2" style="font-size: 12px; color: var(--bad);">
        Не удалось загрузить статистику.
      </div>
      <div v-else-if="showSpinner && rows.length === 0" class="center" style="padding: 16px;"><Spinner /></div>
      <div v-else-if="rows.length === 0" class="placeholder" style="min-height: 64px;">
        Нет данных. Варианты появятся после первых отправок с opener-вариантом.
      </div>
      <table v-else class="tbl">
        <thead>
          <tr>
            <th>Вариант</th>
            <th class="num">Отправлено</th>
            <th class="num">Ответили</th>
            <th>Reply rate</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.variantKey">
            <td class="cell-strong mono">{{ r.variantKey }}</td>
            <td class="num mono">{{ formatNumber(r.sent) }}</td>
            <td class="num mono">{{ formatNumber(r.replied) }}</td>
            <td style="min-width: 160px;">
              <div style="display: flex; align-items: center; gap: 8px;">
                <Bar :value="r.replyRate" :width="80" tone="ok" />
                <span class="mono" style="font-size: 11.5px;">{{ formatPct(r.replyRate, 1) }}</span>
              </div>
            </td>
          </tr>
        </tbody>
        <tbody>
          <!-- Totals row — rendered in tbody (not tfoot) because `.tbl` only
               styles thead/tbody, so a tfoot row would render without
               padding/borders. Top border separates it visually. -->
          <tr>
            <td class="muted-2" style="border-top: 1px solid var(--line);">Итого</td>
            <td class="num mono" style="border-top: 1px solid var(--line);">{{ formatNumber(totals.sent) }}</td>
            <td class="num mono" style="border-top: 1px solid var(--line);">{{ formatNumber(totals.replied) }}</td>
            <td class="mono" style="font-size: 11.5px; border-top: 1px solid var(--line);">{{ formatPct(totals.rate, 1) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
