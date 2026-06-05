<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { useRouter } from 'vue-router';
import PageHead from '../../components/PageHead.vue';
import Tabs from '../../components/Tabs.vue';
import FilterBar from '../../components/FilterBar.vue';
import FilterChipSelect from '../../components/FilterChipSelect.vue';
import Tag from '../../components/Tag.vue';
import Avatar from '../../components/Avatar.vue';
import Icon from '../../components/Icon.vue';
import Spinner from '../../components/Spinner.vue';
import EmptyState from '../../components/EmptyState.vue';
import Dropdown from '../../components/Dropdown.vue';
import FeatureOff from '../../components/FeatureOff.vue';
import { api } from '../../lib/api';
import { isFeatureOff } from '../../lib/featureGate';
import { avatarColor } from '../../lib/state';
import { formatCompact, formatRelative, initials } from '../../lib/format';
import type { IconName } from '../../lib/icons';
import type { BloggerProfile, BloggerProfileList } from './types';

const router = useRouter();
const qc = useQueryClient();

type BloggerTab = 'all' | 'with_rates' | 'with_audience' | 'needs_data';
const tab = ref<BloggerTab>('all');
const platformFilter = ref('');
const langFilter = ref('');
const formatFilter = ref('');

const { data, isLoading, isFetching, error } = useQuery({
  queryKey: ['blogger-profiles'],
  queryFn: () => api.get<BloggerProfileList>('/blogger-profiles?limit=200'),
  retry: false,
});

const featureOff = computed(() => isFeatureOff(error.value));
const items = computed<BloggerProfile[]>(() => data.value?.items ?? []);

const platformOptions = [
  { value: 'telegram', label: 'Telegram' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'vk', label: 'VK' },
  { value: 'tiktok', label: 'TikTok' },
];

const langOptions = computed(() =>
  [...new Set(items.value.flatMap((p) => p.languages))]
    .filter(Boolean)
    .sort()
    .map((value) => ({ value, label: value })),
);

const formatOptions = computed(() =>
  [...new Set(items.value.flatMap((p) => p.formats))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 30)
    .map((value) => ({ value, label: value })),
);

function hasRates(p: BloggerProfile): boolean {
  return p.rateCards.length > 0 || (p.placementOffers?.length ?? 0) > 0;
}

function hasAudience(p: BloggerProfile): boolean {
  return p.reach != null || p.avgViews != null;
}

const counts = computed(() => ({
  all: items.value.length,
  with_rates: items.value.filter(hasRates).length,
  with_audience: items.value.filter(hasAudience).length,
  needs_data: items.value.filter((p) => !hasRates(p) || !hasAudience(p)).length,
}));

const tabsList = computed(() => [
  { id: 'all', label: 'Все', count: counts.value.all },
  { id: 'with_rates', label: 'С прайсом', count: counts.value.with_rates },
  { id: 'with_audience', label: 'С охватом', count: counts.value.with_audience },
  { id: 'needs_data', label: 'Нужны данные', count: counts.value.needs_data },
]);

const filteredItems = computed(() => {
  let xs = items.value;
  if (tab.value === 'with_rates') xs = xs.filter(hasRates);
  if (tab.value === 'with_audience') xs = xs.filter(hasAudience);
  if (tab.value === 'needs_data') xs = xs.filter((p) => !hasRates(p) || !hasAudience(p));
  if (platformFilter.value) {
    xs = xs.filter(
      (p) =>
        (p.socialLinks ?? []).some((link) => link.platform === platformFilter.value) ||
        (p.placementOffers ?? []).some((offer) => offer.platform === platformFilter.value),
    );
  }
  if (langFilter.value) xs = xs.filter((p) => p.languages.includes(langFilter.value));
  if (formatFilter.value) xs = xs.filter((p) => p.formats.includes(formatFilter.value));
  return xs;
});

function topRates(p: BloggerProfile): string {
  if ((p.placementOffers?.length ?? 0) > 0) {
    return (
      p
        .placementOffers!.filter((o) => o.price != null)
        .slice(0, 2)
        .map((o) => `${offerKindLabel(o.kind)}: ${formatCompact(o.price)} ${o.currency}`)
        .join(' · ') || 'по запросу'
    );
  }
  if (!p.rateCards.length) return '—';
  return p.rateCards
    .slice(0, 2)
    .map((r) => `${r.format}: ${formatCompact(r.price)} ${r.currency}`)
    .join(' · ');
}

function profileName(p: BloggerProfile): string {
  return p.displayName || p.channelId || p.id.slice(0, 8);
}

function primaryPlatform(p: BloggerProfile): string | null {
  return (
    p.socialLinks?.[0]?.platform ?? p.placementOffers?.find((o) => o.platform)?.platform ?? null
  );
}

function socialLabel(link: NonNullable<BloggerProfile['socialLinks']>[number]): string {
  return `${link.platform}${link.handle ? ` @${link.handle}` : ''}`;
}

function offerKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    post: 'Пост',
    story: 'Сторис',
    reels: 'Reels',
    shorts: 'Shorts',
    video: 'Видео',
    integration: 'Интеграция',
    offsite_review: 'Обзор',
    package: 'Пакет',
    other: 'Другое',
  };
  return labels[kind] ?? kind;
}

function rowActions(p: BloggerProfile): Array<{
  label: string;
  icon?: IconName;
  onClick?: () => void;
  divider?: boolean;
}> {
  return [
    {
      label: 'Открыть профиль',
      icon: 'edit',
      onClick: () => router.push(`/bloggers/${p.id}`),
    },
    {
      label: 'Перейти к подбору',
      icon: 'users_round',
      onClick: () => router.push('/match'),
    },
  ];
}
</script>

<template>
  <PageHead
    title="Каталог блогеров"
    :sub="featureOff ? 'Раздел недоступен' : `${data?.total ?? 0} профилей в базе`"
  >
    <template #actions>
      <button
        class="btn"
        :disabled="isFetching"
        @click="qc.invalidateQueries({ queryKey: ['blogger-profiles'] })"
      >
        <span v-if="isFetching" class="spinner" />
        <Icon v-else name="refresh" :size="12" /><span>Обновить</span>
      </button>
      <button class="btn primary" @click="router.push('/match')">
        <Icon name="users_round" :size="12" /><span>Подбор</span>
      </button>
    </template>
  </PageHead>

  <FeatureOff v-if="featureOff" flag="ENABLE_AGENCY_SOURCING" />

  <template v-else>
    <Tabs :tabs="tabsList" :active="tab" @change="(id) => (tab = id as BloggerTab)" />
    <FilterBar>
      <FilterChipSelect
        v-model="platformFilter"
        label="Платформа"
        :options="platformOptions"
        placeholder="любая"
      />
      <FilterChipSelect
        v-model="langFilter"
        label="Язык"
        :options="langOptions"
        placeholder="любой"
        tone="ok"
      />
      <FilterChipSelect
        v-model="formatFilter"
        label="Формат"
        :options="formatOptions"
        placeholder="любой"
        tone="violet"
      />
      <template #right>
        <span class="muted-2">{{ filteredItems.length }} из {{ items.length }}</span>
      </template>
    </FilterBar>

    <div v-if="isLoading" class="center"><Spinner /></div>
    <EmptyState
      v-else-if="filteredItems.length === 0"
      title="Профилей пока нет"
      description="Профили собираются автоматически из входящих диалогов агентского типа кампаний."
      icon="users_round"
    />
    <div v-else class="table-wrap">
      <table class="tbl">
        <thead>
          <tr>
            <th style="width: 28px"><input type="checkbox" /></th>
            <th>Профиль</th>
            <th>Платф.</th>
            <th>Темы</th>
            <th>Форматы</th>
            <th class="num">Охват</th>
            <th class="num">Ср. просмотры</th>
            <th>Прайс</th>
            <th>Данные</th>
            <th>Обновлён</th>
            <th style="width: 28px"></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in filteredItems"
            :key="row.id"
            class="clickable"
            @click="router.push(`/bloggers/${row.id}`)"
          >
            <td @click.stop><input type="checkbox" /></td>
            <td>
              <div style="display: flex; align-items: center; gap: 9px">
                <Avatar :text="initials(profileName(row))" :color="avatarColor(row.id)" />
                <div>
                  <div class="cell-strong">{{ profileName(row) }}</div>
                  <div
                    v-if="row.socialLinks?.length"
                    style="display: flex; gap: 6px; margin-top: 2px"
                  >
                    <a
                      v-for="link in row.socialLinks.slice(0, 2)"
                      :key="`${link.platform}:${link.url}`"
                      class="mono muted-2"
                      style="font-size: 10.5px"
                      :href="link.url"
                      target="_blank"
                      rel="noreferrer"
                      @click.stop
                    >
                      {{ socialLabel(link) }}
                    </a>
                    <span
                      v-if="row.socialLinks.length > 2"
                      class="mono muted-2"
                      style="font-size: 10.5px"
                      >+{{ row.socialLinks.length - 2 }}</span
                    >
                  </div>
                  <div v-else class="mono muted-2" style="font-size: 10.5px">
                    {{ row.channelId ?? row.id.slice(0, 8) }}
                  </div>
                </div>
              </div>
            </td>
            <td>
              <Tag v-if="primaryPlatform(row)" :platform="primaryPlatform(row) ?? undefined" />
              <span v-else class="muted-2">—</span>
            </td>
            <td>
              <div style="display: flex; flex-wrap: wrap; gap: 4px">
                <Tag v-for="t in row.topics.slice(0, 3)" :key="t">{{ t }}</Tag>
                <span v-if="row.topics.length > 3" class="muted-2"
                  >+{{ row.topics.length - 3 }}</span
                >
                <span v-if="!row.topics.length" class="muted-2">—</span>
              </div>
            </td>
            <td>
              <div style="display: flex; flex-wrap: wrap; gap: 4px">
                <Tag v-for="f in row.formats.slice(0, 3)" :key="f">{{ f }}</Tag>
                <span v-if="row.formats.length > 3" class="muted-2"
                  >+{{ row.formats.length - 3 }}</span
                >
                <span v-if="!row.formats.length" class="muted-2">—</span>
              </div>
            </td>
            <td class="num mono">{{ row.reach != null ? formatCompact(row.reach) : '—' }}</td>
            <td class="num mono">{{ row.avgViews != null ? formatCompact(row.avgViews) : '—' }}</td>
            <td>
              <span class="muted" style="font-size: 12px">{{ topRates(row) }}</span>
            </td>
            <td class="mono">{{ row._count?.dataPoints ?? row.dataPoints?.length ?? 0 }}</td>
            <td>
              <span class="muted-2 mono" style="font-size: 10.5px">{{
                formatRelative(row.updatedAt)
              }}</span>
            </td>
            <td @click.stop>
              <Dropdown :items="rowActions(row)" align="right">
                <button class="btn ghost icon-only sm" title="Действия">
                  <Icon name="more" :size="12" />
                </button>
              </Dropdown>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </template>
</template>
