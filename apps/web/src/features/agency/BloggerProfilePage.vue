<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { useRoute, useRouter } from 'vue-router';
import PageHead from '../../components/PageHead.vue';
import Spinner from '../../components/Spinner.vue';
import Icon from '../../components/Icon.vue';
import Tag from '../../components/Tag.vue';
import KeyValue, { type KvItem } from '../../components/KeyValue.vue';
import ConfBar from '../../components/ConfBar.vue';
import FeatureOff from '../../components/FeatureOff.vue';
import EmptyState from '../../components/EmptyState.vue';
import MediaKitDownload from './MediaKitDownload.vue';
import { api } from '../../lib/api';
import { isFeatureOff } from '../../lib/featureGate';
import { formatCompact, formatDateTime } from '../../lib/format';
import type { BloggerProfile, ProfileDataPoint } from './types';

const route = useRoute();
const router = useRouter();
const id = computed(() => route.params.id as string);

const { data: profile, isLoading, error } = useQuery({
  queryKey: ['blogger-profile', id],
  queryFn: () => api.get<BloggerProfile>(`/blogger-profiles/${id.value}`),
  enabled: computed(() => !!id.value),
  retry: false,
});

const featureOff = computed(() => isFeatureOff(error.value));

const standardKv = computed<KvItem[]>(() => {
  const p = profile.value;
  if (!p) return [];
  return [
    { label: 'Канал', value: p.channelId ?? '—', mono: true },
    { label: 'Языки', value: p.languages.join(', ') || '—' },
    { label: 'Охват', value: p.reach != null ? formatCompact(p.reach) : '—' },
    { label: 'Ср. просмотры', value: p.avgViews != null ? formatCompact(p.avgViews) : '—' },
    { label: 'Снято (captured)', value: p.capturedAt ? formatDateTime(p.capturedAt) : '—' },
    { label: 'Обновлён', value: formatDateTime(p.updatedAt) },
  ];
});

const dataPoints = computed<ProfileDataPoint[]>(() => profile.value?.dataPoints ?? []);

// A data point references a downloadable asset when its value is an asset id
// and the field signals media (media kit / screenshot). The profile read
// endpoint does not currently embed media_asset rows, so we surface a download
// affordance for any provenance that carries an explicit assetId.
function assetId(dp: ProfileDataPoint): string | null {
  if (dp.field.startsWith('media') || dp.field === 'media_kit') {
    if (typeof dp.value === 'string' && dp.value) return dp.value;
    if (dp.value && typeof dp.value === 'object' && 'assetId' in (dp.value as object)) {
      const v = (dp.value as { assetId?: unknown }).assetId;
      if (typeof v === 'string') return v;
    }
  }
  return null;
}

function renderValue(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
</script>

<template>
  <PageHead :title="profile?.channelId ?? 'Профиль блогера'" sub="Стандартизированный коммерческий профиль">
    <template #actions>
      <button class="btn" @click="router.push('/bloggers')">
        <Icon name="arrow_left" :size="12" /><span>К каталогу</span>
      </button>
    </template>
  </PageHead>

  <FeatureOff v-if="featureOff" flag="ENABLE_AGENCY_SOURCING" />
  <div v-else-if="isLoading" class="center"><Spinner /></div>
  <EmptyState v-else-if="!profile" title="Профиль не найден" icon="users_round" />

  <template v-else>
    <!-- Standardized fields -->
    <div class="card">
      <div class="card-head"><Icon name="users_round" :size="12" /><span>Стандартизированные поля</span></div>
      <div class="card-body">
        <KeyValue :items="standardKv" />
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

    <!-- Rate cards -->
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
              <td class="mono" style="font-size: 12px;">{{ dp.field }}</td>
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
              <td>
                <MediaKitDownload
                  v-if="assetId(dp)"
                  :asset-id="assetId(dp)!"
                  label="Медиа-кит"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </template>
</template>
