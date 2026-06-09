<script setup lang="ts">
import { computed, ref } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { useRoute, useRouter } from 'vue-router';
import PageHead from '../../components/PageHead.vue';
import Spinner from '../../components/Spinner.vue';
import Icon from '../../components/Icon.vue';
import S3Image from '../../components/S3Image.vue';
import Tag from '../../components/Tag.vue';
import KeyValue, { type KvItem } from '../../components/KeyValue.vue';
import ConfBar from '../../components/ConfBar.vue';
import FeatureOff from '../../components/FeatureOff.vue';
import EmptyState from '../../components/EmptyState.vue';
import MediaKitDownload from './MediaKitDownload.vue';
import FreshnessPanel from './FreshnessPanel.vue';
import { api, ApiError } from '../../lib/api';
import { isFeatureOff } from '../../lib/featureGate';
import { formatCompact, formatDateTime, formatRelative } from '../../lib/format';
import { toast } from '../../lib/toast';
import type {
  BloggerPostInsight,
  BloggerProfile,
  PlacementAttribute,
  PlacementOffer,
  ProfileDataPoint,
  MediaAsset,
} from './types';

const route = useRoute();
const router = useRouter();
const qc = useQueryClient();
const id = computed(() => route.params.id as string);

const { data: profile, isLoading, error } = useQuery({
  queryKey: ['blogger-profile', id],
  queryFn: () => api.get<BloggerProfile>(`/blogger-profiles/${id.value}`),
  enabled: computed(() => !!id.value),
  retry: false,
});

// A flag-off route is a 404 without an application NOT_FOUND code; a genuinely
// missing profile is a 404 whose body carries code NOT_FOUND. We must show a
// proper "не найдено" state for the latter rather than the disabled-feature
// panel (which would lie about why the page is empty).
const featureOff = computed(() => isFeatureOff(error.value));
const notFound = computed(
  () => error.value instanceof ApiError && error.value.status === 404 && error.value.code === 'NOT_FOUND',
);

const standardKv = computed<KvItem[]>(() => {
  const p = profile.value;
  if (!p) return [];
  return [
    { label: 'Профиль', value: p.displayName || p.channelId || p.id, mono: !p.displayName },
    { label: 'Канал', value: p.channelId ?? '—', mono: true },
    { label: 'Языки', value: p.languages.join(', ') || '—' },
    { label: 'Охват', value: p.reach != null ? formatCompact(p.reach) : '—' },
    { label: 'Ср. просмотры', value: p.avgViews != null ? formatCompact(p.avgViews) : '—' },
    { label: 'Снято (captured)', value: p.capturedAt ? formatDateTime(p.capturedAt) : '—' },
    { label: 'Обновлён', value: formatDateTime(p.updatedAt) },
  ];
});

const dataPoints = computed<ProfileDataPoint[]>(() => profile.value?.dataPoints ?? []);
const mediaAssets = computed<MediaAsset[]>(() => profile.value?.mediaAssets ?? []);
const postInsights = computed<BloggerPostInsight[]>(() => profile.value?.postInsights ?? []);
// Structured placement offers (entity-style-rate-cards). When present they are
// the source of truth for commercial terms; the legacy "Прайс" table is the
// fallback for profiles with no structured offers.
const placementOffers = computed<PlacementOffer[]>(() => profile.value?.placementOffers ?? []);

const PLACEMENT_KIND_RU: Record<string, string> = {
  post: 'Пост',
  story: 'Сторис',
  reels: 'Reels',
  shorts: 'Shorts',
  video: 'Видео',
  integration: 'Интеграция',
  offsite_review: 'Выездной обзор',
  package: 'Пакет',
  other: 'Другое',
};

const PLACEMENT_ATTR_RU: Record<string, string> = {
  duration: 'Срок',
  delete_policy: 'Удаление',
  includes: 'Входит',
  tax: 'Налог',
  notes: 'Примечания',
};

function offerKindLabel(o: PlacementOffer): string {
  return PLACEMENT_KIND_RU[o.kind] ?? o.kind;
}

function offerPriceLabel(o: PlacementOffer): string {
  if (o.price == null) return 'по запросу';
  return `${formatCompact(o.price)} ${o.currency}`;
}

function attrLabel(key: string): string {
  return PLACEMENT_ATTR_RU[key] ?? key;
}

function attrValue(a: PlacementAttribute): string {
  if (Array.isArray(a.value)) return a.value.join(', ');
  return String(a.value);
}

// Attributes other than promoted/price fields, in a stable display order.
function offerTerms(o: PlacementOffer): PlacementAttribute[] {
  const order = ['duration', 'delete_policy', 'includes', 'tax', 'notes'];
  return [...o.attributes]
    .filter((a) => a.key !== 'price' && a.key !== 'currency' && a.key !== 'kind' && a.key !== 'platform')
    .sort((a, b) => {
      const ia = order.indexOf(a.key);
      const ib = order.indexOf(b.key);
      return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
    });
}

function assetLabel(a: MediaAsset): string {
  const kind = a.kind === 'media_kit' ? 'Медиа-кит' : a.kind === 'screenshot' ? 'Скриншот' : a.kind;
  const size = a.bytes != null ? ` · ${formatCompact(a.bytes)} Б` : '';
  return `${kind}${size}`;
}

function postMetricLabel(post: BloggerPostInsight): string {
  const m = post.metrics;
  const parts = [
    m.views != null ? `${formatCompact(m.views)} views` : '',
    m.likes != null ? `${formatCompact(m.likes)} likes` : '',
    m.comments != null ? `${formatCompact(m.comments)} comments` : '',
    m.reactions != null ? `${formatCompact(m.reactions)} react` : '',
    m.forwards != null ? `${formatCompact(m.forwards)} fwd` : '',
  ].filter(Boolean);
  return parts.join(' · ') || 'метрик нет';
}

function postFreshnessLabel(post: BloggerPostInsight): string {
  if (post.freshness.state === 'fresh') return `fresh · ${post.freshness.ageDays ?? 0} д`;
  if (post.freshness.state === 'stale') return `stale · ${post.freshness.ageDays ?? '?'} д`;
  if (post.freshness.state === 'pending') return 'обновляется';
  return 'нет метрик';
}

function profileTitle(): string {
  const p = profile.value;
  return p?.displayName || p?.channelId || 'Профиль блогера';
}

function socialLabel(link: NonNullable<BloggerProfile['socialLinks']>[number]): string {
  return `${link.platform}${link.handle ? ` @${link.handle}` : ''}`;
}

function renderValue(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const refreshMut = useMutation({
  mutationFn: () => api.post(`/blogger-profiles/${id.value}/post-insights/refresh`, {}),
  onSuccess: () => {
    toast.success('Обновление постов поставлено в очередь');
    qc.invalidateQueries({ queryKey: ['blogger-profile'] });
  },
  onError: (e) => toast.error('Не удалось обновить посты', (e as Error).message),
});

// Per-platform audience (placement-representation-v2) — subscribers per platform.
const platformAudience = computed(() => profile.value?.platformAudience ?? []);

// Operator corrections (operator-reanalyze-and-markup): delete a wrong machine
// point; write an operator-origin value that the roll-up prefers.
const deleteDpMut = useMutation({
  mutationFn: (dpId: string) => api.del(`/blogger-profiles/${id.value}/data-points/${dpId}`),
  onSuccess: () => {
    toast.success('Точка данных удалена; профиль пересчитан');
    qc.invalidateQueries({ queryKey: ['blogger-profile'] });
  },
  onError: (e) => toast.error('Не удалось удалить', (e as Error).message),
});
const writeForm = ref<{ field: string; value: string }>({ field: '', value: '' });
const writeDpMut = useMutation({
  mutationFn: (body: { field: string; value: unknown }) =>
    api.post(`/blogger-profiles/${id.value}/data-points`, body),
  onSuccess: () => {
    toast.success('Операторская правка сохранена');
    writeForm.value = { field: '', value: '' };
    qc.invalidateQueries({ queryKey: ['blogger-profile'] });
  },
  onError: (e) => toast.error('Не удалось сохранить', (e as Error).message),
});
function submitWrite(): void {
  const field = writeForm.value.field.trim();
  if (!field) return;
  const raw = writeForm.value.value.trim();
  const num = Number(raw.replace(/[\s,]/g, ''));
  writeDpMut.mutate({ field, value: Number.isFinite(num) && raw !== '' ? num : raw });
}

// Extraction hint (operator-reanalyze-and-markup): teach the agents a nuance for
// this blogger's channel that the next analysis honors.
const hintText = ref('');
const hintMut = useMutation({
  mutationFn: (guidance: string) =>
    api.post('/extraction-hints', {
      scope: profile.value?.channelId ? 'channel' : 'global',
      channelId: profile.value?.channelId ?? null,
      guidance,
    }),
  onSuccess: () => {
    toast.success('Подсказка сохранена; агенты учтут её при следующем анализе');
    hintText.value = '';
  },
  onError: (e) => toast.error('Не удалось сохранить подсказку', (e as Error).message),
});
function submitHint(): void {
  const g = hintText.value.trim();
  if (g) hintMut.mutate(g);
}
</script>

<template>
  <PageHead :title="profileTitle()" sub="Стандартизированный коммерческий профиль">
    <template #actions>
      <button
        class="btn"
        :disabled="refreshMut.isPending.value || profile?.postInsightRefreshStatus === 'pending'"
        @click="refreshMut.mutate()"
      >
        <span v-if="refreshMut.isPending.value" class="spinner" />
        <Icon v-else name="refresh" :size="12" /><span>Обновить посты</span>
      </button>
      <button class="btn" @click="router.push('/bloggers')">
        <Icon name="arrow_left" :size="12" /><span>К каталогу</span>
      </button>
    </template>
  </PageHead>

  <FeatureOff v-if="featureOff" flag="ENABLE_AGENCY_SOURCING" />
  <div v-else-if="isLoading" class="center"><Spinner /></div>
  <EmptyState
    v-else-if="notFound"
    title="Профиль не найден"
    description="Профиль блогера с таким id не существует или был удалён."
    icon="users_round"
  >
    <template #action>
      <button class="btn" @click="router.push('/bloggers')"><Icon name="arrow_left" :size="12" /><span>К каталогу</span></button>
    </template>
  </EmptyState>
  <EmptyState v-else-if="!profile" title="Профиль недоступен" icon="users_round" />

  <template v-else>
    <!-- Per-section observation freshness (newest usable contributing
         data point per section, gated by category-specific TTL). Read-only
         signal — see profile-staleness.ts for semantics. Detail-only payload
         field, so it may be absent on legacy responses. -->
    <FreshnessPanel v-if="profile.freshness" :freshness="profile.freshness" style="margin-bottom: 12px;" />

    <div class="card" style="margin-bottom: 12px;">
      <div class="card-head">
        <Icon name="list" :size="12" /><span>Топ-посты ({{ postInsights.length }})</span>
        <span v-if="profile.postInsightRefreshStatus !== 'idle'" class="muted-2" style="margin-left: 6px;">
          {{ profile.postInsightRefreshStatus }}
        </span>
      </div>
      <div class="card-body">
        <div v-if="profile.postInsightRefreshStatus === 'pending'" class="placeholder" style="min-height: 44px;">Метрики постов обновляются.</div>
        <div v-else-if="profile.postInsightRefreshStatus === 'unsupported'" class="placeholder" style="min-height: 44px;">Источник не поддерживает обновление постов: {{ profile.postInsightRefreshError ?? 'нет публичного канала' }}</div>
        <div v-else-if="profile.postInsightRefreshStatus === 'failed'" class="placeholder" style="min-height: 44px;">Последнее обновление постов завершилось ошибкой: {{ profile.postInsightRefreshError ?? '—' }}</div>
        <div v-if="!postInsights.length" class="placeholder" style="min-height: 48px;">Посты с метриками пока не собраны.</div>
        <div v-else style="display: grid; gap: 8px;">
          <div
            v-for="post in postInsights.slice(0, 12)"
            :key="post.id"
            style="border: 1px solid var(--line); border-radius: 8px; padding: 10px;"
          >
            <div style="display: flex; justify-content: space-between; gap: 8px; align-items: center; flex-wrap: wrap;">
              <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                <Tag :platform="post.platform">{{ post.platform }}</Tag>
                <span class="mono muted-2" style="font-size: 11px;">{{ post.mediaKind }}</span>
                <span class="mono cell-strong" style="font-size: 12px;">{{ postMetricLabel(post) }}</span>
              </div>
              <div style="display: flex; align-items: center; gap: 8px;">
                <span class="muted-2" style="font-size: 11px;">{{ postFreshnessLabel(post) }}</span>
                <a v-if="post.url" class="btn ghost icon-only sm" :href="post.url" target="_blank" rel="noreferrer" title="Открыть пост">
                  <Icon name="arrow_up_right" :size="12" />
                </a>
              </div>
            </div>
            <div style="display: flex; gap: 9px; margin-top: 7px;">
              <!-- Post-example image (blogger-profile-who-is-this): visual «who is this». -->
              <S3Image
                v-if="post.hasImage"
                :url-path="`/blogger-post-insights/${post.id}/image-url`"
                :alt="post.textSnippet"
                :size="84"
              />
              <div class="muted" style="font-size: 12.5px; line-height: 1.45; min-width: 0; flex: 1;">
                {{ post.textSnippet || '—' }}
              </div>
            </div>
            <div class="muted-2" style="font-size: 10.5px; margin-top: 7px;">
              опубликован {{ formatRelative(post.publishedAt) }} · метрики {{ formatRelative(post.metricCapturedAt) }} · source {{ post.source }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Standardized fields -->
    <div class="card">
      <div class="card-head"><Icon name="users_round" :size="12" /><span>Стандартизированные поля</span></div>
      <div class="card-body">
        <KeyValue :items="standardKv" />
        <div v-if="profile.socialLinks?.length" style="margin-top: 12px;">
          <div class="muted-2" style="font-size: 11px; text-transform: uppercase; margin-bottom: 6px;">Соцпрофили</div>
          <div style="display: flex; flex-wrap: wrap; gap: 8px;">
            <a
              v-for="link in profile.socialLinks"
              :key="`${link.platform}:${link.url}`"
              class="btn"
              style="height: 28px; padding: 0 9px; font-size: 12px;"
              :href="link.url"
              target="_blank"
              rel="noreferrer"
            >
              <Icon name="arrow_up_right" :size="12" />
              <span>{{ socialLabel(link) }}</span>
            </a>
          </div>
        </div>
        <div style="margin-top: 12px;">
          <div class="muted-2" style="font-size: 11px; text-transform: uppercase; margin-bottom: 6px;">Темы</div>
          <div style="display: flex; flex-wrap: wrap; gap: 4px;">
            <Tag v-for="t in profile.topics" :key="t">{{ t }}</Tag>
            <span v-if="!profile.topics.length" class="muted-2">—</span>
          </div>
        </div>
        <div style="margin-top: 12px;">
          <div class="muted-2" style="font-size: 11px; text-transform: uppercase; margin-bottom: 6px;">Форматы</div>
          <div style="display: flex; flex-wrap: wrap; gap: 4px;">
            <Tag v-for="f in profile.formats" :key="f">{{ f }}</Tag>
            <span v-if="!profile.formats.length" class="muted-2">—</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Structured placement offers (entity-style-rate-cards). Each offer is a
         commercial object with typed terms; the raw source snippet is the audit
         affordance back to the original message (mirrors the data-points table). -->
    <div v-if="placementOffers.length" class="card" style="margin-top: 12px;">
      <div class="card-head">
        <Icon name="flag" :size="12" /><span>Размещения ({{ placementOffers.length }})</span>
        <span class="muted-2" style="margin-left: 6px;">структурированные коммерческие условия</span>
      </div>
      <div class="card-body" style="display: flex; flex-direction: column; gap: 10px;">
        <div
          v-for="(o, i) in placementOffers"
          :key="i"
          style="border: 1px solid var(--border, #2a2a2a); border-radius: 8px; padding: 10px;"
        >
          <div style="display: flex; align-items: baseline; justify-content: space-between; gap: 8px; flex-wrap: wrap;">
            <div style="display: flex; align-items: center; gap: 6px;">
              <Tag>{{ offerKindLabel(o) }}</Tag>
              <span v-if="o.platform" class="muted-2" style="font-size: 12px;">{{ o.platform }}</span>
            </div>
            <span class="cell-strong mono">{{ offerPriceLabel(o) }}</span>
          </div>
          <div v-if="offerTerms(o).length" style="margin-top: 8px; display: flex; flex-direction: column; gap: 3px;">
            <div
              v-for="a in offerTerms(o)"
              :key="a.key"
              style="display: flex; gap: 8px; font-size: 12px;"
            >
              <span class="muted-2" style="min-width: 92px;">{{ attrLabel(a.key) }}</span>
              <span>{{ attrValue(a) }}</span>
            </div>
          </div>
          <div style="margin-top: 8px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <ConfBar :value="o.confidence" />
            <span class="mono muted-2" style="font-size: 11px;">{{ Math.round(o.confidence * 100) }}%</span>
            <span
              v-if="o.rawSnippet"
              class="muted-2"
              style="font-size: 11.5px; font-style: italic;"
              :title="o.sourceMessageId ? `Источник: ${o.sourceMessageId}` : undefined"
            >«{{ o.rawSnippet }}»</span>
            <span v-else-if="o.sourceMessageId" class="muted-2" style="font-size: 11px;">
              источник: {{ o.sourceMessageId }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- Rate cards (legacy fallback when there are no structured offers, and the
         compatibility view of derived cards otherwise). -->
    <div class="card" style="margin-top: 12px;">
      <div class="card-head"><Icon name="flag" :size="12" /><span>Прайс ({{ profile.rateCards.length }})</span></div>
      <div class="card-body">
        <div v-if="!profile.rateCards.length" class="placeholder" style="min-height: 48px;">Прайсы не собраны.</div>
        <table v-else class="tbl">
          <thead><tr><th>Формат</th><th class="num">Цена</th><th>Валюта</th><th>Примечание</th></tr></thead>
          <tbody>
            <tr v-for="(r, i) in profile.rateCards" :key="i">
              <td class="cell-strong">{{ r.format }}</td>
              <td class="num mono">{{ formatCompact(r.price) }}</td>
              <td>{{ r.currency }}</td>
              <td><span class="muted-2">{{ r.unit ?? '—' }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Audience -->
    <div class="card" style="margin-top: 12px;">
      <div class="card-head"><Icon name="globe" :size="12" /><span>Аудитория</span></div>
      <!-- Per-platform subscribers (placement-representation-v2) -->
      <div v-if="platformAudience.length" class="card-body" style="padding-bottom: 0;">
        <div class="muted-2" style="font-size: 11px; text-transform: uppercase; margin-bottom: 6px;">Подписчики по платформам</div>
        <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 4px;">
          <div
            v-for="pa in platformAudience"
            :key="pa.platform"
            style="display: flex; align-items: baseline; gap: 6px; padding: 4px 9px; border: 1px solid var(--line); border-radius: 7px;"
          >
            <span class="muted" style="font-size: 11.5px; text-transform: capitalize;">{{ pa.platform }}</span>
            <span class="mono cell-strong">{{ formatCompact(pa.subscribers) }}</span>
          </div>
        </div>
      </div>
      <div class="card-body" style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px;">
        <div v-for="seg in (['geo', 'age', 'gender'] as const)" :key="seg">
          <div class="muted-2" style="font-size: 11px; text-transform: uppercase; margin-bottom: 6px;">{{ seg }}</div>
          <div v-if="profile.audience?.[seg] && Object.keys(profile.audience[seg]!).length">
            <div
              v-for="(share, label) in profile.audience[seg]"
              :key="label"
              style="display: flex; justify-content: space-between; font-size: 12px; padding: 2px 0;"
            >
              <span class="muted">{{ label }}</span>
              <span class="mono">{{ share <= 1 ? `${Math.round(share * 100)}%` : formatCompact(share) }}</span>
            </div>
          </div>
          <span v-else class="muted-2">—</span>
        </div>
      </div>
    </div>

    <!-- Media kits & screenshots -->
    <div class="card" style="margin-top: 12px;">
      <div class="card-head"><Icon name="download" :size="12" /><span>Медиа-киты ({{ mediaAssets.length }})</span></div>
      <div class="card-body">
        <div v-if="!mediaAssets.length" class="placeholder" style="min-height: 48px;">Файлы не получены.</div>
        <table v-else class="tbl">
          <thead><tr><th>Файл</th><th>MIME</th><th>Получен</th><th></th></tr></thead>
          <tbody>
            <tr v-for="a in mediaAssets" :key="a.id">
              <td class="cell-strong">{{ assetLabel(a) }}</td>
              <td><span class="muted-2 mono" style="font-size: 11.5px;">{{ a.mime ?? '—' }}</span></td>
              <td><span class="muted-2" style="font-size: 11px;">{{ formatDateTime(a.createdAt) }}</span></td>
              <td style="text-align: right;">
                <MediaKitDownload :asset-id="a.id" :mime="a.mime" label="Скачать" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Data points with provenance -->
    <div class="card" style="margin-top: 12px;">
      <div class="card-head">
        <Icon name="list" :size="12" /><span>Точки данных ({{ dataPoints.length }})</span>
        <span class="muted-2" style="margin-left: 6px;">провенанс: значение, уверенность, исходный фрагмент</span>
      </div>
      <div class="card-body">
        <div v-if="!dataPoints.length" class="placeholder" style="min-height: 48px;">Точек данных нет.</div>
        <table v-else class="tbl">
          <thead>
            <tr>
              <th>Поле</th><th>Значение</th><th>Уверенность</th><th>Источник (raw)</th><th>Снято</th><th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="dp in dataPoints" :key="dp.id">
              <td class="mono" style="font-size: 12px;">
                {{ dp.field }}
                <span v-if="dp.extractedBy === 'operator'" class="mono" style="font-size: 9.5px; color: var(--accent-2);" title="Правка оператора">✎</span>
              </td>
              <td>
                <span class="cell-strong">{{ renderValue(dp.value) }}</span>
                <span v-if="dp.unit" class="muted-2"> {{ dp.unit }}</span>
              </td>
              <td style="min-width: 90px;">
                <div style="display: flex; align-items: center; gap: 6px;">
                  <ConfBar :value="dp.confidence" />
                  <span class="mono" style="font-size: 11px;">{{ Math.round(dp.confidence * 100) }}%</span>
                </div>
              </td>
              <td>
                <span class="muted-2" style="font-size: 11.5px; font-style: italic;">{{ dp.rawSnippet || '—' }}</span>
              </td>
              <td><span class="muted-2" style="font-size: 11px;">{{ formatDateTime(dp.capturedAt) }}</span></td>
              <td style="text-align: right;">
                <button
                  type="button"
                  class="btn-icon"
                  title="Удалить точку данных"
                  :disabled="deleteDpMut.isPending.value"
                  style="background: none; border: none; cursor: pointer; color: var(--ink-4);"
                  @click="deleteDpMut.mutate(dp.id)"
                ><Icon name="trash" :size="12" /></button>
              </td>
            </tr>
          </tbody>
        </table>
        <!-- Operator correction: add an operator-origin value the roll-up prefers
             (operator-reanalyze-and-markup). Field-aware validation is server-side. -->
        <form
          style="display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap;"
          @submit.prevent="submitWrite"
        >
          <input
            v-model="writeForm.field"
            class="input mono"
            style="font-size: 11.5px; width: 200px;"
            placeholder="поле (напр. reach, rate.post)"
          />
          <input
            v-model="writeForm.value"
            class="input"
            style="font-size: 11.5px; width: 160px;"
            placeholder="значение"
          />
          <button class="btn" type="submit" :disabled="writeDpMut.isPending.value || !writeForm.field.trim()">
            <Icon name="plus" :size="11" /><span>Добавить правку</span>
          </button>
        </form>
        <!-- Extraction hint: teach the agents this blogger's nuance for next time. -->
        <form
          style="display: flex; gap: 8px; align-items: center; margin-top: 8px; flex-wrap: wrap;"
          @submit.prevent="submitHint"
        >
          <input
            v-model="hintText"
            class="input"
            style="font-size: 11.5px; flex: 1; min-width: 240px;"
            placeholder="Подсказка агенту (напр. «МАХ — это мессенджер MAX, площадка max»)"
          />
          <button class="btn" type="submit" :disabled="hintMut.isPending.value || !hintText.trim()">
            <Icon name="spark" :size="11" /><span>Сохранить подсказку</span>
          </button>
        </form>
      </div>
    </div>
  </template>
</template>
