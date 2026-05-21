<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { useRouter } from 'vue-router';
import PageHead from '../../components/PageHead.vue';
import DataTable from '../../components/DataTable.vue';
import Tag from '../../components/Tag.vue';
import FeatureOff from '../../components/FeatureOff.vue';
import { api } from '../../lib/api';
import { isFeatureOff } from '../../lib/featureGate';
import { formatCompact, formatRelative } from '../../lib/format';
import type { BloggerProfile, BloggerProfileList } from './types';

const router = useRouter();

const { data, isLoading, error } = useQuery({
  queryKey: ['blogger-profiles'],
  queryFn: () => api.get<BloggerProfileList>('/blogger-profiles?limit=200'),
  retry: false,
});

const featureOff = computed(() => isFeatureOff(error.value));
const items = computed<BloggerProfile[]>(() => data.value?.items ?? []);

function topRates(p: BloggerProfile): string {
  if (!p.rateCards.length) return '—';
  return p.rateCards
    .slice(0, 2)
    .map((r) => `${r.format}: ${formatCompact(r.price)} ${r.currency}`)
    .join(' · ');
}
</script>

<template>
  <PageHead
    title="Каталог блогеров"
    :sub="featureOff ? 'Раздел недоступен' : `${data?.total ?? 0} профилей в базе`"
  />

  <FeatureOff v-if="featureOff" flag="ENABLE_AGENCY_SOURCING" />

  <DataTable
    v-else
    :rows="items"
    :loading="isLoading"
    :row-key="(p) => p.id"
    empty-title="Профилей пока нет"
    empty-description="Профили собираются автоматически из входящих диалогов агентского типа кампаний."
    :on-row-click="(p) => router.push(`/bloggers/${p.id}`)"
  >
    <template #head>
      <tr>
        <th>Профиль</th>
        <th>Темы</th>
        <th>Форматы</th>
        <th class="num">Охват</th>
        <th class="num">Ср. просмотры</th>
        <th>Прайс</th>
        <th>Точек данных</th>
        <th>Обновлён</th>
      </tr>
    </template>
    <template #row="{ row }">
      <td>
        <span class="cell-strong">{{ row.channelId ?? row.id.slice(0, 8) }}</span>
        <div v-if="row.languages.length" class="muted-2" style="font-size: 11px;">
          {{ row.languages.join(', ') }}
        </div>
      </td>
      <td>
        <div style="display: flex; flex-wrap: wrap; gap: 4px;">
          <Tag v-for="t in row.topics.slice(0, 4)" :key="t">{{ t }}</Tag>
          <span v-if="row.topics.length > 4" class="muted-2">+{{ row.topics.length - 4 }}</span>
          <span v-if="!row.topics.length" class="muted-2">—</span>
        </div>
      </td>
      <td><span class="muted">{{ row.formats.join(', ') || '—' }}</span></td>
      <td class="num mono">{{ row.reach != null ? formatCompact(row.reach) : '—' }}</td>
      <td class="num mono">{{ row.avgViews != null ? formatCompact(row.avgViews) : '—' }}</td>
      <td><span class="muted" style="font-size: 12px;">{{ topRates(row) }}</span></td>
      <td class="mono">{{ row._count?.dataPoints ?? row.dataPoints?.length ?? 0 }}</td>
      <td><span class="muted-2">{{ formatRelative(row.updatedAt) }}</span></td>
    </template>
  </DataTable>
</template>
