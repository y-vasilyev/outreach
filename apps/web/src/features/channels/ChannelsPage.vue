<script setup lang="ts">
import { computed, ref } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import PageHead from '../../components/PageHead.vue';
import Tabs from '../../components/Tabs.vue';
import FilterBar from '../../components/FilterBar.vue';
import FilterChipSelect from '../../components/FilterChipSelect.vue';
import Pill from '../../components/Pill.vue';
import Tag from '../../components/Tag.vue';
import Avatar from '../../components/Avatar.vue';
import Bar from '../../components/Bar.vue';
import Icon from '../../components/Icon.vue';
import Spinner from '../../components/Spinner.vue';
import EmptyState from '../../components/EmptyState.vue';
import Dropdown from '../../components/Dropdown.vue';
import ChannelImportDialog from './ChannelImportDialog.vue';
import ChannelDetailDrawer from './ChannelDetailDrawer.vue';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { formatCompact, initials, formatRelative } from '../../lib/format';
import { avatarColor } from '../../lib/state';
import type { Channel } from './types';
import type { IconName } from '../../lib/icons';

const qc = useQueryClient();

// Tab ids must match `ChannelStatus` enum values that the API accepts.
type ChannelTab = 'all' | 'new' | 'scraping' | 'extracted' | 'failed';
const tab = ref<ChannelTab>('all');
const search = ref('');
const platformFilter = ref('');
const langFilter = ref('');
const minSubs = ref('');

const platformOptions = [
  { value: 'telegram', label: 'Telegram' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'youtube', label: 'YouTube' },
];
const langOptions = [
  { value: 'ru', label: 'ru' },
  { value: 'en', label: 'en' },
];
const subsOptions = [
  { value: '1k', label: '≥ 1K' },
  { value: '5k', label: '≥ 5K' },
  { value: '10k', label: '≥ 10K' },
];

const importOpen = ref(false);
const selected = ref<Channel | null>(null);

const queryKey = computed(() => ['channels', { tab: tab.value, search: search.value, platform: platformFilter.value }] as const);

const { data, isLoading } = useQuery({
  queryKey,
  queryFn: () => {
    const qs = new URLSearchParams();
    if (search.value) qs.set('q', search.value);
    if (platformFilter.value) qs.set('platform', platformFilter.value);
    if (tab.value !== 'all') qs.set('status', tab.value);
    return api.get<{ items: Channel[]; total: number } | Channel[]>(`/channels?${qs.toString()}`);
  },
});

const channels = computed<Channel[]>(() => {
  const d = data.value;
  if (!d) return [];
  if (Array.isArray(d)) return d;
  return d.items;
});

const filteredChannels = computed<Channel[]>(() => {
  let xs = channels.value;
  if (langFilter.value) xs = xs.filter((c) => (c.language ?? '').toLowerCase() === langFilter.value);
  if (minSubs.value) {
    const min = minSubs.value === '1k' ? 1000 : minSubs.value === '5k' ? 5000 : 10000;
    xs = xs.filter((c) => (c.followers ?? 0) >= min);
  }
  return xs;
});

const counts = computed(() => {
  const all = channels.value.length;
  return {
    all,
    // Match the same `status` filter the API will receive when the tab is
    // selected — otherwise the badge count and the listing would disagree.
    new: channels.value.filter((c) => c.status === 'new').length,
    scraping: channels.value.filter((c) => c.status === 'scraping' || c.status === 'extracting').length,
    extracted: channels.value.filter((c) => c.status === 'extracted' || c.status === 'ready' || c.status === 'done').length,
    failed: channels.value.filter((c) => c.status === 'failed').length,
  };
});

const scrapeAllMut = useMutation({
  mutationFn: async () => {
    const ids = channels.value.map((c) => c.id);
    await Promise.all(ids.map((id) => api.post<void>(`/channels/${id}/scrape`, {}).catch(() => undefined)));
  },
  onSuccess: () => {
    toast.info('Скрейп поставлен в очередь', `${channels.value.length} каналов`);
    qc.invalidateQueries({ queryKey: ['channels'] });
  },
});

/**
 * Re-run the scrape on a single channel. Same endpoint as the bulk button —
 * the service flips status to `new` and clears `lastError` before queueing,
 * so a `failed` row immediately stops looking failed in the UI on refetch.
 */
const rescrapeOneMut = useMutation({
  mutationFn: (id: string) => api.post<{ ok: true }>(`/channels/${id}/scrape`, {}),
  onSuccess: (_v, id) => {
    const ch = channels.value.find((c) => c.id === id);
    toast.info('Скрейп поставлен в очередь', ch ? `@${ch.handle}` : id);
    qc.invalidateQueries({ queryKey: ['channels'] });
  },
  onError: (e: Error) => toast.error('Не удалось перескрейпить', e.message),
});

function rowActions(c: Channel): Array<{
  label: string;
  icon?: IconName;
  onClick?: () => void;
  variant?: 'default' | 'danger';
  divider?: boolean;
}> {
  const isError = c.status === 'failed';
  return [
    {
      label: 'Открыть',
      icon: 'edit',
      onClick: () => (selected.value = c),
    },
    {
      label: isError ? 'Повторить парсинг' : 'Перескрейпить',
      icon: 'refresh',
      onClick: () => rescrapeOneMut.mutate(c.id),
    },
  ];
}

const tabsList = computed(() => [
  { id: 'all', label: 'Все', count: counts.value.all },
  { id: 'new', label: 'Новые', count: counts.value.new },
  { id: 'scraping', label: 'Скрейпинг', count: counts.value.scraping },
  { id: 'extracted', label: 'Готовы', count: counts.value.extracted },
  { id: 'failed', label: 'Ошибки', count: counts.value.failed },
]);
</script>

<template>
  <PageHead title="Каналы" :sub="`${counts.all} каналов · 3 платформы`">
    <template #actions>
      <button class="btn" @click="importOpen = true"><Icon name="upload" :size="12" /><span>Импорт</span></button>
      <button class="btn" :disabled="scrapeAllMut.isPending.value" @click="scrapeAllMut.mutate()">
        <span v-if="scrapeAllMut.isPending.value" class="spinner" />
        <Icon v-else name="refresh" :size="12" /><span>Перескрейпить</span>
      </button>
      <button class="btn primary" @click="importOpen = true">
        <Icon name="plus" :size="12" /><span>Добавить канал</span><span class="kbd">N</span>
      </button>
    </template>
  </PageHead>
  <Tabs :tabs="tabsList" :active="tab" @change="(id) => (tab = id as any)" />
  <FilterBar>
    <FilterChipSelect v-model="platformFilter" label="Платформа" :options="platformOptions" placeholder="любая" />
    <FilterChipSelect v-model="langFilter" label="Язык" :options="langOptions" placeholder="любой" tone="ok" />
    <FilterChipSelect v-model="minSubs" label="Подписчики" :options="subsOptions" placeholder="любые" />
    <template #right>
      <span class="muted-2">{{ filteredChannels.length }} из {{ channels.length }}</span>
    </template>
  </FilterBar>

  <div v-if="isLoading" class="center"><Spinner /></div>
  <EmptyState
    v-else-if="filteredChannels.length === 0"
    title="Каналов нет"
    description="Импортируйте список или вставьте handle-ы вручную."
    icon="layers"
  >
    <template #action>
      <button class="btn primary" @click="importOpen = true"><Icon name="plus" :size="12" /><span>Импорт</span></button>
    </template>
  </EmptyState>
  <div v-else class="table-wrap">
    <table class="tbl">
      <thead>
        <tr>
          <th style="width: 28px;"><input type="checkbox" /></th>
          <th>Канал</th>
          <th>Платф.</th>
          <th>Тематика</th>
          <th style="text-align: right;">Подп.</th>
          <th>Скрейп</th>
          <th>Контакты</th>
          <th>Статус</th>
          <th>Добавлен</th>
          <th style="width: 28px;"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="c in filteredChannels" :key="c.id" class="clickable" @click="selected = c">
          <td @click.stop><input type="checkbox" /></td>
          <td>
            <div style="display: flex; align-items: center; gap: 9px;">
              <Avatar :text="initials(c.title || c.handle)" :color="avatarColor(c.id)" />
              <div>
                <div class="cell-strong">{{ c.title || c.handle }}</div>
                <div class="mono muted-2" style="font-size: 10.5px;">{{ c.handle }}</div>
              </div>
            </div>
          </td>
          <td><Tag :platform="c.platform" /></td>
          <td class="muted">{{ c.analysis?.topic ?? '—' }}</td>
          <td class="mono" style="text-align: right;">{{ formatCompact(c.followers ?? null) }}</td>
          <td>
            <template v-if="c.status === 'scraping'">
              <div style="display: flex; align-items: center; gap: 6px;">
                <Bar :value="0.5" pct :width="60" />
                <span class="mono muted-2" style="font-size: 10.5px;">…</span>
              </div>
            </template>
            <span v-else-if="c.status === 'failed'" class="muted-2 mono" style="font-size: 10.5px;">error</span>
            <span v-else class="muted-2 mono" style="font-size: 10.5px;">{{ formatRelative(c.scrapedAt ?? null) }}</span>
          </td>
          <td>
            <span v-if="(c._count?.contacts ?? 0) > 0" style="display: inline-flex; gap: 4px; align-items: center;">
              <span class="mono cell-strong">{{ c._count!.contacts }}</span>
              <span class="muted-2">контакт{{ c._count!.contacts > 1 ? 'ов' : '' }}</span>
            </span>
            <span v-else class="muted-2">—</span>
          </td>
          <td><Pill :state="c.status" /></td>
          <td class="muted-2 mono" style="font-size: 10.5px;">{{ formatRelative(c.createdAt) }}</td>
          <td @click.stop>
            <Dropdown :items="rowActions(c)" align="right">
              <button class="btn ghost icon-only sm" :title="c.lastError ?? ''">
                <Icon name="more" :size="12" />
              </button>
            </Dropdown>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <ChannelImportDialog
    :open="importOpen"
    @close="importOpen = false"
    @done="() => { importOpen = false; qc.invalidateQueries({ queryKey: ['channels'] }); }"
  />
  <ChannelDetailDrawer :channel="selected" @close="selected = null" @action="qc.invalidateQueries({ queryKey: ['channels'] })" />
</template>
