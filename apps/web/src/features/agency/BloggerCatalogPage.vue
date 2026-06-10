<script setup lang="ts">
import { computed, ref } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
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
import { toast } from '../../lib/toast';
import type { IconName } from '../../lib/icons';
import type { BloggerPostInsight, BloggerProfile, BloggerProfileList } from './types';

const router = useRouter();
const qc = useQueryClient();

type BloggerTab = 'all' | 'with_rates' | 'with_audience' | 'needs_data';
const tab = ref<BloggerTab>('all');
const query = ref('');
const platformFilter = ref('');
const langFilter = ref('');
const formatFilter = ref('');
const contextType = ref<'none' | 'campaign' | 'brief'>('none');
const contextId = ref('');
const sortMode = ref<'updated' | 'relevance' | 'top_posts' | 'price_asc' | 'cpm_asc'>('updated');
const requirePostMetrics = ref(false);

// Server-side OFFER filters (catalog-sql-search): executed in SQL over the
// placement_offer rows — price/CPM caps, kind, прайс-freshness, server sorts.
// Facet split: offer-facts = server; text/topic/platform/language = client.
const serverKind = ref('');
const serverPriceMax = ref('');
const serverCpmMax = ref('');
const serverFreshDays = ref('');

const serverSort = computed(() =>
  sortMode.value === 'price_asc' || sortMode.value === 'cpm_asc' ? sortMode.value : 'updated',
);

const { data, isLoading, isFetching, error } = useQuery({
  queryKey: [
    'blogger-profiles',
    contextType,
    contextId,
    platformFilter,
    serverKind,
    serverPriceMax,
    serverCpmMax,
    serverFreshDays,
    serverSort,
  ],
  queryFn: () => {
    const params = new URLSearchParams({ limit: '200' });
    if (contextType.value === 'campaign' && contextId.value.trim()) params.set('campaignId', contextId.value.trim());
    if (contextType.value === 'brief' && contextId.value.trim()) params.set('briefId', contextId.value.trim());
    // Platform is a SERVER facet (codex review): older matches beyond the
    // first page must not be lost to client-side filtering.
    if (platformFilter.value) params.set('platform', platformFilter.value);
    if (serverKind.value) params.set('kind', serverKind.value);
    const priceMax = Number(serverPriceMax.value.replace(/\s/g, ''));
    if (Number.isFinite(priceMax) && priceMax > 0) params.set('priceRubMax', String(priceMax));
    const cpmMax = Number(serverCpmMax.value.replace(/\s/g, ''));
    if (Number.isFinite(cpmMax) && cpmMax > 0) params.set('cpmRubMax', String(cpmMax));
    const freshDays = Number(serverFreshDays.value);
    if (Number.isInteger(freshDays) && freshDays > 0) params.set('offerFreshDays', String(freshDays));
    if (serverSort.value !== 'updated') params.set('sort', serverSort.value);
    return api.get<BloggerProfileList>(`/blogger-profiles?${params.toString()}`);
  },
  retry: false,
});

const featureOff = computed(() => isFeatureOff(error.value));
const items = computed<BloggerProfile[]>(() => data.value?.items ?? []);

const kindOptions = [
  { value: 'post', label: 'пост' },
  { value: 'story', label: 'сторис' },
  { value: 'reels', label: 'рилс' },
  { value: 'video', label: 'видео' },
  { value: 'integration', label: 'интеграция' },
  { value: 'offsite_review', label: 'выездной обзор' },
  { value: 'package', label: 'пакет' },
];

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
  return p.reach != null || p.avgViews != null || (p.platformAudience?.length ?? 0) > 0;
}

// Side-by-side compare (blogger-profile-who-is-this, Path A). Select 2–4 bloggers
// and align them on per-platform audience + prices per format.
const compareIds = ref<string[]>([]);
function toggleCompare(pid: string): void {
  const i = compareIds.value.indexOf(pid);
  if (i >= 0) compareIds.value.splice(i, 1);
  else if (compareIds.value.length < 4) compareIds.value.push(pid);
}
const compareItems = computed<BloggerProfile[]>(() =>
  compareIds.value.map((cid) => items.value.find((p) => p.id === cid)).filter((p): p is BloggerProfile => !!p),
);
const showCompare = computed(() => compareItems.value.length >= 2);
const comparePlatforms = computed(() => {
  const set = new Set<string>();
  for (const p of compareItems.value) for (const pa of p.platformAudience ?? []) set.add(pa.platform);
  return [...set].sort();
});
function platformSubs(p: BloggerProfile, platform: string): number | null {
  return p.platformAudience?.find((pa) => pa.platform === platform)?.subscribers ?? null;
}

function hasUsablePostMetric(p: BloggerProfile): boolean {
  return (p.topPostsPreview ?? []).some(
    (post) =>
      post.freshness.state === 'fresh' &&
      Object.values(post.metrics).some((v) => typeof v === 'number' && Number.isFinite(v)),
  );
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
  if (langFilter.value) xs = xs.filter((p) => p.languages.includes(langFilter.value));
  if (formatFilter.value) xs = xs.filter((p) => p.formats.includes(formatFilter.value));
  // Free-text search over name / topics / social handle (blogger-profile-who-is-this).
  const q = query.value.trim().toLowerCase();
  if (q) {
    xs = xs.filter((p) => {
      const hay = [
        profileName(p),
        ...(p.topics ?? []),
        ...((p.socialLinks ?? []).map((l) => l.handle ?? l.url)),
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }
  if (requirePostMetrics.value) xs = xs.filter(hasUsablePostMetric);
  xs = [...xs];
  if (sortMode.value === 'relevance') {
    xs.sort((a, b) => (b.fit?.score ?? -1) - (a.fit?.score ?? -1));
  } else if (sortMode.value === 'top_posts') {
    xs.sort((a, b) => topPostScore(b) - topPostScore(a));
  }
  // price_asc / cpm_asc: the SERVER ordered by the best qualifying offer —
  // keep its order.
  return xs;
});

function topRates(p: BloggerProfile): string {
  if ((p.placementOffers?.length ?? 0) > 0) {
    return (
      p
        .placementOffers!.filter((o) => o.price != null)
        .slice(0, 2)
        .map((o) => {
          // ₽-hint for fx-converted prices + stale marker (catalog-sql-search):
          // an old price must not read as fresh in the list/compare views.
          const rub =
            o.normalized?.priceRubMin != null && (o.normalized?.fxRateUsed ?? 1) !== 1
              ? ` ≈${formatCompact(o.normalized.priceRubMin)} ₽`
              : '';
          const stale = o.stale ? ' (устарело)' : '';
          return `${offerKindLabel(o.kind)}: ${formatCompact(o.price)} ${o.currency}${rub}${stale}`;
        })
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

function topPostScore(p: BloggerProfile): number {
  return Math.max(0, ...(p.topPostsPreview ?? []).map((post) => post.performanceScore));
}

function postMetricLabel(post: BloggerPostInsight): string {
  const m = post.metrics;
  const parts = [
    m.views != null ? `${formatCompact(m.views)} views` : '',
    m.likes != null ? `${formatCompact(m.likes)} likes` : '',
    m.reactions != null ? `${formatCompact(m.reactions)} react` : '',
    m.forwards != null ? `${formatCompact(m.forwards)} fwd` : '',
  ].filter(Boolean);
  return parts.join(' · ') || 'метрик нет';
}

function topPostLabel(p: BloggerProfile): string {
  const post = p.topPostsPreview?.[0];
  if (!post) return p.postInsightRefreshStatus === 'pending' ? 'обновление…' : '—';
  return `${post.platform}: ${postMetricLabel(post)}`;
}

function fitLabel(p: BloggerProfile): string {
  if (!p.fit) return '—';
  return `${Math.round(p.fit.score * 100)}%`;
}

function fitTitle(p: BloggerProfile): string {
  if (!p.fit) return '';
  return [p.fit.rationale, ...p.fit.positiveSignals.map((s) => `+ ${s}`), ...p.fit.gaps.map((g) => `- ${g}`)].join('\n');
}

const refreshMut = useMutation({
  mutationFn: (profileId: string) => api.post(`/blogger-profiles/${profileId}/post-insights/refresh`, {}),
  onSuccess: () => {
    toast.success('Обновление постов поставлено в очередь');
    qc.invalidateQueries({ queryKey: ['blogger-profiles'] });
  },
  onError: (e) => toast.error('Не удалось обновить посты', (e as Error).message),
});

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
    { label: 'divider', divider: true },
    {
      label: 'Обновить посты',
      icon: 'refresh',
      onClick: () => refreshMut.mutate(p.id),
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
      <input
        v-model="query"
        class="input"
        style="height: 30px; width: 200px;"
        placeholder="Поиск: имя / тема / ник"
      />
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
      <label style="display: flex; align-items: center; gap: 6px;">
        <span class="muted-2" style="font-size: 11px;">Контекст</span>
        <select v-model="contextType" class="input" style="height: 30px; width: 116px;">
          <option value="none">нет</option>
          <option value="campaign">campaign</option>
          <option value="brief">brief</option>
        </select>
      </label>
      <input
        v-if="contextType !== 'none'"
        v-model="contextId"
        class="input"
        style="height: 30px; width: 230px;"
        :placeholder="contextType === 'campaign' ? 'campaignId' : 'briefId'"
      />
      <FilterChipSelect
        v-model="serverKind"
        label="Тип"
        :options="kindOptions"
        placeholder="любой"
        tone="warn"
      />
      <input
        v-model="serverPriceMax"
        class="input"
        style="height: 30px; width: 110px;"
        placeholder="Цена до, ₽"
        inputmode="numeric"
        title="Максимальная цена размещения в рублях (SQL-фильтр по активным офферам)"
      />
      <input
        v-model="serverCpmMax"
        class="input"
        style="height: 30px; width: 100px;"
        placeholder="CPM до, ₽"
        inputmode="numeric"
        title="Максимальный CPM (₽ за 1000 просмотров)"
      />
      <input
        v-model="serverFreshDays"
        class="input"
        style="height: 30px; width: 110px;"
        placeholder="Свежее, дн."
        inputmode="numeric"
        title="Только офферы, полученные за последние N дней"
      />
      <label style="display: flex; align-items: center; gap: 6px;">
        <span class="muted-2" style="font-size: 11px;">Сорт.</span>
        <select v-model="sortMode" class="input" style="height: 30px; width: 136px;">
          <option value="updated">обновление</option>
          <option value="relevance">релевантность</option>
          <option value="top_posts">топ-посты</option>
          <option value="price_asc">цена ↑</option>
          <option value="cpm_asc">CPM ↑</option>
        </select>
      </label>
      <label style="display: flex; align-items: center; gap: 6px; font-size: 12px;">
        <input v-model="requirePostMetrics" type="checkbox" />
        <span>с метриками постов</span>
      </label>
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
            <th class="num">Fit</th>
            <th>Топ-пост</th>
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
            <td @click.stop>
              <input
                type="checkbox"
                title="Добавить в сравнение"
                :checked="compareIds.includes(row.id)"
                :disabled="!compareIds.includes(row.id) && compareIds.length >= 4"
                @change="toggleCompare(row.id)"
              />
            </td>
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
            <td class="num mono" :title="fitTitle(row)">
              <span :class="row.fit ? 'cell-strong' : 'muted-2'">{{ fitLabel(row) }}</span>
            </td>
            <td>
              <span class="muted" style="font-size: 12px;" :title="row.topPostsPreview?.[0]?.textSnippet ?? row.postInsightRefreshError ?? ''">
                {{ topPostLabel(row) }}
              </span>
              <span v-if="row.postInsightRefreshStatus === 'failed'" class="muted-2" style="display: block; font-size: 10.5px;">ошибка обновления</span>
              <span v-else-if="row.topPostsPreview?.[0]?.freshness.state === 'stale'" class="muted-2" style="display: block; font-size: 10.5px;">метрики устарели</span>
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

    <!-- Side-by-side compare (Path A): pick 2–4 bloggers via the row checkboxes. -->
    <div v-if="showCompare" class="card" style="margin-top: 12px;">
      <div class="card-head">
        <Icon name="layers" :size="12" /><span>Сравнение ({{ compareItems.length }})</span>
        <button class="btn" style="margin-left: auto;" @click="compareIds = []">Очистить</button>
      </div>
      <div class="card-body" style="overflow-x: auto;">
        <table class="tbl">
          <thead>
            <tr>
              <th></th>
              <th v-for="p in compareItems" :key="p.id">{{ profileName(p) }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="plat in comparePlatforms" :key="plat">
              <td class="mono" style="text-transform: capitalize;">{{ plat }} подписчики</td>
              <td v-for="p in compareItems" :key="p.id" class="mono">
                {{ platformSubs(p, plat) != null ? formatCompact(platformSubs(p, plat)!) : '—' }}
              </td>
            </tr>
            <tr>
              <td class="mono">Охват</td>
              <td v-for="p in compareItems" :key="p.id" class="mono">{{ p.reach != null ? formatCompact(p.reach) : '—' }}</td>
            </tr>
            <tr>
              <td class="mono">Прайс</td>
              <td v-for="p in compareItems" :key="p.id" style="font-size: 11.5px;">{{ topRates(p) }}</td>
            </tr>
            <tr>
              <td class="mono">Форматы</td>
              <td v-for="p in compareItems" :key="p.id" style="font-size: 11.5px;">{{ (p.formats ?? []).slice(0, 4).join(', ') || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </template>
</template>
