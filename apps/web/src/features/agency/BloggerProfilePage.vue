<script setup lang="ts">
import { computed } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { useRoute, useRouter } from 'vue-router';
import PageHead from '../../components/PageHead.vue';
import Spinner from '../../components/Spinner.vue';
import Icon from '../../components/Icon.vue';
import S3Image from '../../components/S3Image.vue';
import Tag from '../../components/Tag.vue';
import ConfBar from '../../components/ConfBar.vue';
import FeatureOff from '../../components/FeatureOff.vue';
import EmptyState from '../../components/EmptyState.vue';
import MediaKitDownload from './MediaKitDownload.vue';
import BloggerProfileHeader from './BloggerProfileHeader.vue';
import BloggerMetricsStrip from './BloggerMetricsStrip.vue';
import BloggerAuditSection from './BloggerAuditSection.vue';
import { api, ApiError } from '../../lib/api';
import { isFeatureOff } from '../../lib/featureGate';
import { formatCompact, formatDateTime, formatRelative } from '../../lib/format';
import { toast } from '../../lib/toast';
import { bloggerDisplayTitle } from './blogger-display';
import type {
  BloggerPostInsight,
  BloggerProfile,
  PlacementAttribute,
  PlacementOffer,
  MediaAsset,
} from './types';

// Decision-ux page order: «кто это» (шапка) → «сколько стоит и насколько
// живой» (метрики, размещения) → «моя ли аудитория» (демография) → пруфы
// (топ-посты, медиа-киты) → аудит экстракции (свёрнут).
const route = useRoute();
const router = useRouter();
const qc = useQueryClient();
const id = computed(() => route.params.id as string);

// Fit-verdict context (decision-ux): the catalog passes its campaign/brief
// context through the URL so the detail can answer «совпадает ли с брифом».
const fitCtx = computed(() => ({
  campaignId: typeof route.query.campaignId === 'string' ? route.query.campaignId : '',
  briefId: typeof route.query.briefId === 'string' ? route.query.briefId : '',
}));

const { data: profile, isLoading, error } = useQuery({
  queryKey: ['blogger-profile', id, fitCtx],
  queryFn: () => {
    const params = new URLSearchParams();
    if (fitCtx.value.campaignId) params.set('campaignId', fitCtx.value.campaignId);
    else if (fitCtx.value.briefId) params.set('briefId', fitCtx.value.briefId);
    const qs = params.toString();
    return api.get<BloggerProfile>(`/blogger-profiles/${id.value}${qs ? `?${qs}` : ''}`);
  },
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

const mediaAssets = computed<MediaAsset[]>(() => profile.value?.mediaAssets ?? []);
const postInsights = computed<BloggerPostInsight[]>(() => profile.value?.postInsights ?? []);
// Structured placement offers (entity-style-rate-cards). When present they are
// the source of truth for commercial terms; the legacy "Прайс" table is the
// fallback for profiles with no structured offers.
const placementOffers = computed<PlacementOffer[]>(() => profile.value?.placementOffers ?? []);

// Мультиплатформенный блогер: размещения группируются по платформе; основная
// платформа (привязанный канал) идёт первой, безплатформенные офферы — в конце.
const offerGroups = computed<Array<{ platform: string | null; offers: PlacementOffer[] }>>(() => {
  const groups = new Map<string, PlacementOffer[]>();
  for (const o of placementOffers.value) {
    const key = o.platform ?? '';
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  const primary = profile.value?.channel?.platform?.toLowerCase() ?? null;
  return [...groups.entries()]
    .map(([platform, offers]) => ({ platform: platform || null, offers }))
    .sort((a, b) => {
      if (a.platform === null) return 1;
      if (b.platform === null) return -1;
      if (a.platform === primary) return -1;
      if (b.platform === primary) return 1;
      return a.platform.localeCompare(b.platform);
    });
});

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
  // Range bounds (price-normalization-v2): «от X» / «до X» / «X–Y».
  if (o.price_min != null || o.price_max != null) {
    if (o.price_min != null && o.price_max != null)
      return `${formatCompact(o.price_min)}–${formatCompact(o.price_max)} ${o.currency}`;
    if (o.price_min != null) return `от ${formatCompact(o.price_min)} ${o.currency}`;
    return `до ${formatCompact(o.price_max!)} ${o.currency}`;
  }
  if (o.price == null) return 'по запросу';
  return `${formatCompact(o.price)} ${o.currency}`;
}

/** ₽-normalization hint: converted price by rate date and/or CPM («≈» = по avgViews). */
function offerNormalizedHint(o: PlacementOffer): string {
  const n = o.normalized;
  if (!n) return '';
  const bits: string[] = [];
  if (n.priceRubMin != null && (n.fxRateUsed ?? 1) !== 1) {
    const date = n.fxAsOf ? ` по курсу от ${n.fxAsOf.slice(0, 10)}` : '';
    bits.push(`≈ ${formatCompact(n.priceRubMin)} ₽${date}`);
  }
  if (n.cpmRub != null) {
    const approx = n.viewsSource === 'profile_avg' ? '≈ ' : '';
    bits.push(`CPM ${approx}${formatCompact(n.cpmRub)} ₽`);
  }
  return bits.join(' · ');
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
  if (post.freshness.state === 'fresh') return `свежие · ${post.freshness.ageDays ?? 0} д`;
  if (post.freshness.state === 'stale') return `устарели · ${post.freshness.ageDays ?? '?'} д`;
  if (post.freshness.state === 'pending') return 'обновляется';
  return 'нет метрик';
}

// Tone for the freshness badge (green = fresh, amber = stale, neutral else).
function postFreshnessTone(post: BloggerPostInsight): string {
  if (post.freshness.state === 'fresh') return 'ok';
  if (post.freshness.state === 'stale') return 'warn';
  return '';
}

// Metrics as discrete stat tiles (value + label) instead of one cramped mono
// string — readable at a glance in a card grid.
function postMetricChips(post: BloggerPostInsight): Array<{ label: string; value: string }> {
  const m = post.metrics;
  const out: Array<{ label: string; value: string }> = [];
  if (m.views != null) out.push({ label: 'просмотры', value: formatCompact(m.views) });
  if (m.likes != null) out.push({ label: 'лайки', value: formatCompact(m.likes) });
  if (m.reactions != null) out.push({ label: 'реакции', value: formatCompact(m.reactions) });
  if (m.comments != null) out.push({ label: 'комменты', value: formatCompact(m.comments) });
  if (m.forwards != null) out.push({ label: 'репосты', value: formatCompact(m.forwards) });
  if (m.shares != null) out.push({ label: 'шеры', value: formatCompact(m.shares) });
  if (m.saves != null) out.push({ label: 'сохран.', value: formatCompact(m.saves) });
  if (m.engagementRate != null) {
    const er = m.engagementRate <= 1 ? m.engagementRate * 100 : m.engagementRate;
    out.push({ label: 'ER', value: `${er.toFixed(1)}%` });
  }
  return out;
}

function profileTitle(): string {
  return profile.value ? bloggerDisplayTitle(profile.value) : 'Профиль блогера';
}

const refreshMut = useMutation({
  mutationFn: () => api.post(`/blogger-profiles/${id.value}/post-insights/refresh`, {}),
  onSuccess: () => {
    toast.success('Обновление постов поставлено в очередь');
    qc.invalidateQueries({ queryKey: ['blogger-profile'] });
  },
  onError: (e) => toast.error('Не удалось обновить посты', (e as Error).message),
});
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

  <div class="page-scroll">
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
    <!-- «Кто это»: имя, платформы, темы — без внутренних идентификаторов. -->
    <BloggerProfileHeader :profile="profile">
      <!-- Fit verdict при заходе из каталога с контекстом кампании/брифа. -->
      <div
        v-if="profile.fit"
        style="border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; max-width: 640px;"
      >
        <div style="display: flex; align-items: baseline; gap: 8px;">
          <span style="font-size: 13px; font-weight: 600;">Совпадение с брифом: {{ Math.round(profile.fit.score * 100) }}%</span>
          <span class="muted-2" style="font-size: 10.5px;">{{ profile.fit.source === 'llm_rerank' ? 'LLM-ранжирование' : profile.fit.source === 'match_result' ? 'по результату подбора' : 'детерминированная оценка' }}</span>
        </div>
        <p v-if="profile.fit.rationale" class="muted" style="margin: 0; font-size: 12px;">{{ profile.fit.rationale }}</p>
        <div v-if="profile.fit.positiveSignals.length || profile.fit.gaps.length" style="display: flex; flex-direction: column; gap: 2px; font-size: 11.5px;">
          <span v-for="s in profile.fit.positiveSignals" :key="`+${s}`" style="color: var(--ok);">+ {{ s }}</span>
          <span v-for="g in profile.fit.gaps" :key="`-${g}`" style="color: var(--warn);">− {{ g }}</span>
        </div>
      </div>
    </BloggerProfileHeader>

    <!-- Решающие метрики с inline-бейджами свежести. -->
    <BloggerMetricsStrip :profile="profile" style="margin-top: 12px;" />

    <!-- Structured placement offers (entity-style-rate-cards), grouped per
         platform. Each offer is a commercial object with typed terms; the raw
         source snippet is the audit affordance back to the original message. -->
    <div v-if="placementOffers.length" class="card" style="margin-top: 12px;">
      <div class="card-head">
        <Icon name="flag" :size="12" /><span>Размещения ({{ placementOffers.length }})</span>
        <span class="muted-2" style="margin-left: 6px;">структурированные коммерческие условия</span>
      </div>
      <div class="card-body" style="display: flex; flex-direction: column; gap: 12px;">
        <div v-for="group in offerGroups" :key="group.platform ?? 'none'" style="display: flex; flex-direction: column; gap: 8px;">
          <div v-if="offerGroups.length > 1" style="display: flex; align-items: center; gap: 6px;">
            <Tag v-if="group.platform" :platform="group.platform">{{ group.platform }}</Tag>
            <span v-else class="muted-2" style="font-size: 11.5px;">без платформы</span>
            <span class="muted-2" style="font-size: 11px;">{{ group.offers.length }}</span>
          </div>
          <div
            v-for="(o, i) in group.offers"
            :key="i"
            style="border: 1px solid var(--border, #2a2a2a); border-radius: 8px; padding: 10px;"
          >
            <div style="display: flex; align-items: baseline; justify-content: space-between; gap: 8px; flex-wrap: wrap;">
              <div style="display: flex; align-items: center; gap: 6px;">
                <Tag>{{ offerKindLabel(o) }}</Tag>
                <span v-if="o.platform && offerGroups.length === 1" class="muted-2" style="font-size: 12px;">{{ o.platform }}</span>
                <span v-if="o.stale" style="font-size: 11px; color: var(--warn, #b8860b);" title="Цена старше TTL прайсов — уточните актуальность">устарело</span>
              </div>
              <span class="cell-strong mono">
                {{ offerPriceLabel(o) }}
                <span v-if="offerNormalizedHint(o)" class="muted-2" style="font-size: 11px; font-weight: 400;">
                  {{ offerNormalizedHint(o) }}
                </span>
              </span>
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

    <!-- Audience demographics («моя ли аудитория»). Подписчики по платформам
         живут в полосе метрик. -->
    <div class="card" style="margin-top: 12px;">
      <div class="card-head"><Icon name="globe" :size="12" /><span>Аудитория</span></div>
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

    <!-- Top posts: стиль и реальные метрики контента. -->
    <div class="card" style="margin-top: 12px;">
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
        <div v-else class="post-grid">
          <div v-for="post in postInsights.slice(0, 12)" :key="post.id" class="post-card">
            <!-- Post-example image (blogger-profile-who-is-this): visual «who is this». -->
            <S3Image
              v-if="post.hasImage"
              class="post-card__media"
              :url-path="`/blogger-post-insights/${post.id}/image-url`"
              :alt="post.textSnippet"
              :size="120"
            />
            <div v-else class="post-card__media post-card__media--empty">
              <Icon name="eye" :size="18" />
            </div>

            <div class="post-card__body">
              <div class="post-card__head">
                <Tag :platform="post.platform">{{ post.platform }}</Tag>
                <span class="muted-2" style="font-size: 11px;">{{ post.mediaKind }}</span>
                <span class="post-fresh" :class="postFreshnessTone(post)">{{ postFreshnessLabel(post) }}</span>
              </div>

              <div class="post-metrics" :title="postMetricLabel(post)">
                <template v-if="postMetricChips(post).length">
                  <div v-for="mc in postMetricChips(post)" :key="mc.label" class="post-metric">
                    <span class="post-metric__v">{{ mc.value }}</span>
                    <span class="post-metric__l">{{ mc.label }}</span>
                  </div>
                </template>
                <span v-else class="muted-2" style="font-size: 11.5px;">метрик нет</span>
              </div>

              <p class="post-card__snippet">{{ post.textSnippet || '—' }}</p>

              <div class="post-card__foot">
                <span class="muted-2" style="font-size: 10.5px;">{{ formatRelative(post.publishedAt) }}</span>
                <a
                  v-if="post.url"
                  class="btn ghost icon-only sm"
                  :href="post.url"
                  target="_blank"
                  rel="noreferrer"
                  title="Открыть пост"
                >
                  <Icon name="arrow_up_right" :size="12" />
                </a>
              </div>
            </div>
          </div>
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

    <!-- Аудит экстракции: провенанс, правки, hints, свежесть, внутренние ID.
         Свёрнут — это работа «проверить агента», не «выбрать блогера». -->
    <BloggerAuditSection :profile="profile" style="margin-top: 12px;" />
  </template>
  </div>
</template>

<style scoped>
.post-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 10px;
}
.post-card {
  display: flex;
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
  background: var(--paper);
}
.post-card__media {
  flex: none;
}
.post-card__media--empty {
  width: 120px;
  height: 120px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--paper-2);
  color: var(--ink-4);
  border-right: 1px solid var(--line);
}
.post-card__body {
  flex: 1;
  min-width: 0;
  padding: 9px 10px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.post-card__head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.post-fresh {
  margin-left: auto;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--paper-3, rgba(0, 0, 0, 0.06));
  color: var(--ink-3);
  white-space: nowrap;
}
.post-fresh.ok {
  background: var(--ok-bg);
  color: var(--ok);
}
.post-fresh.warn {
  background: var(--warn-bg);
  color: var(--warn);
}
.post-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.post-metric {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  min-width: 46px;
  padding: 3px 7px;
  border: 1px solid var(--line);
  border-radius: 7px;
  line-height: 1.15;
}
.post-metric__v {
  font-family: var(--font-mono);
  font-weight: 600;
  font-size: 12.5px;
  color: var(--ink);
}
.post-metric__l {
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: var(--ink-4);
}
.post-card__snippet {
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--ink-3);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.post-card__foot {
  margin-top: auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
</style>
