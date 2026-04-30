<script setup lang="ts">
import { computed, ref } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import PageHead from '../../components/PageHead.vue';
import Tabs from '../../components/Tabs.vue';
import FilterBar from '../../components/FilterBar.vue';
import Chip from '../../components/Chip.vue';
import Pill from '../../components/Pill.vue';
import Tag from '../../components/Tag.vue';
import Avatar from '../../components/Avatar.vue';
import Bar from '../../components/Bar.vue';
import Icon from '../../components/Icon.vue';
import Spinner from '../../components/Spinner.vue';
import EmptyState from '../../components/EmptyState.vue';
import ChannelImportDialog from './ChannelImportDialog.vue';
import ChannelDetailDrawer from './ChannelDetailDrawer.vue';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { formatCompact, initials, formatRelative } from '../../lib/format';
import { avatarColor } from '../../lib/state';
import type { Channel } from './types';

const qc = useQueryClient();

const tab = ref<'all' | 'scraping' | 'extracted' | 'needs_review' | 'failed'>('all');
const search = ref('');
const platformFilter = ref<'' | 'telegram' | 'instagram' | 'youtube'>('');
const langFilter = ref<'' | 'ru' | 'en'>('ru');
const minSubs = ref<'' | '1k' | '5k' | '10k'>('5k');

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
    scraping: channels.value.filter((c) => c.status === 'scraping').length,
    extracted: channels.value.filter((c) => c.status === 'extracted' || c.status === 'ready').length,
    needs_review: channels.value.filter((c) => c.status === 'needs_review' || c.status === 'new').length,
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

const tabsList = computed(() => [
  { id: 'all', label: 'Все', count: counts.value.all },
  { id: 'scraping', label: 'Скрейпинг', count: counts.value.scraping },
  { id: 'extracted', label: 'Готовы', count: counts.value.extracted },
  { id: 'needs_review', label: 'Ревью', count: counts.value.needs_review },
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
    <Chip
      :label="'Платформа'"
      :value="platformFilter || 'любая'"
      :applied="!!platformFilter"
      removable
      @click="platformFilter = (platformFilter === '' ? 'telegram' : platformFilter === 'telegram' ? 'instagram' : platformFilter === 'instagram' ? 'youtube' : '') as any"
      @remove="platformFilter = ''"
    />
    <Chip
      label="Язык"
      :value="langFilter || 'любой'"
      :applied="!!langFilter"
      tone="ok"
      removable
      @click="langFilter = langFilter === 'ru' ? 'en' : langFilter === 'en' ? '' : 'ru'"
      @remove="langFilter = ''"
    />
    <Chip
      label="Подписчики"
      :value="minSubs ? `≥ ${minSubs.toUpperCase()}` : 'любые'"
      :applied="!!minSubs"
      removable
      @click="minSubs = minSubs === '5k' ? '10k' : minSubs === '10k' ? '1k' : '5k'"
      @remove="minSubs = ''"
    />
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
            <button class="btn ghost icon-only sm"><Icon name="more" :size="12" /></button>
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
