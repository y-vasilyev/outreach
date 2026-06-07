<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import PageHead from '../../components/PageHead.vue';
import Icon from '../../components/Icon.vue';
import Spinner from '../../components/Spinner.vue';
import FeatureOff from '../../components/FeatureOff.vue';
import EmptyState from '../../components/EmptyState.vue';
import Pill from '../../components/Pill.vue';
import Field from '../../components/Field.vue';
import TextInput from '../../components/TextInput.vue';
import TextareaInput from '../../components/TextareaInput.vue';
import SelectInput from '../../components/SelectInput.vue';
import { api, ApiError } from '../../lib/api';
import { isFeatureOff } from '../../lib/featureGate';
import { useFlags } from '../../lib/config';
import { toast } from '../../lib/toast';
import { formatDateTime, formatNumber } from '../../lib/format';
import { guidedStatusPill } from './helpers';
import type {
  DiscoveryBatchListItem,
  DiscoveryCampaignOption,
  DiscoveryResult,
  GuidedRunListItem,
  Platform,
} from './types';

const router = useRouter();
const qc = useQueryClient();
const flags = useFlags();

// Two-layer feature gate: hide entirely when the flag snapshot reports off,
// AND treat a non-application 404 on a discovery list as feature-off (the flag
// may flip between fetch and navigation; route stays unregistered then).
const flagOff = computed(() => flags.value.channelDiscovery === false);

const PLATFORM_OPTS = [
  { value: '', label: 'Все платформы' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'youtube', label: 'YouTube' },
];

function clampLimit(raw: string, fallback = 20): number {
  if (raw.trim().length === 0) return fallback;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(50, n));
}

// ─── guided workbench input ───
// Source can be a campaign (loads its goal/AJTBD) or a manual brief.
const guidedMode = ref<'campaign' | 'manual'>('manual');
const guidedCampaignId = ref<string>('');
const guidedBrief = ref('');
const guidedPlatform = ref<string>('');

// Campaign options for the selector (best-effort; an error just leaves the
// selector empty and the operator can use a manual brief).
const { data: campaigns } = useQuery({
  queryKey: ['discovery-campaign-options'],
  queryFn: async () => {
    const rows = await api.get<DiscoveryCampaignOption[]>('/campaigns');
    return rows.map((c) => ({ id: c.id, name: c.name }));
  },
  enabled: computed(() => !flagOff.value),
  retry: false,
});

const campaignOpts = computed(() => [
  { value: '', label: '— выберите кампанию —' },
  ...(campaigns.value ?? []).map((c) => ({ value: c.id, label: c.name })),
]);

const guidedValid = computed(() =>
  guidedMode.value === 'campaign'
    ? guidedCampaignId.value.length > 0
    : guidedBrief.value.trim().length >= 2,
);

const guidedMut = useMutation({
  mutationFn: () =>
    api.post<{ id: string }>('/discovery/guided', {
      ...(guidedMode.value === 'campaign'
        ? { campaignId: guidedCampaignId.value }
        : { brief: guidedBrief.value.trim() }),
      ...(guidedPlatform.value ? { platform: guidedPlatform.value as Platform } : {}),
    }),
  onSuccess: ({ id }) => {
    qc.invalidateQueries({ queryKey: ['discovery-guided-runs'] });
    toast.success('Запуск создан');
    router.push(`/discovery/guided/${id}`);
  },
  onError: (e: Error) => toast.error('Не удалось запустить', e.message),
});

function submitGuided(): void {
  if (!guidedValid.value || guidedMut.isPending.value) return;
  guidedMut.mutate();
}

// ─── guided runs list ───
const {
  data: guidedRuns,
  isLoading: guidedLoading,
  error: guidedError,
} = useQuery({
  queryKey: ['discovery-guided-runs'],
  queryFn: () => api.get<GuidedRunListItem[]>('/discovery/guided'),
  enabled: computed(() => !flagOff.value),
  retry: false,
});

const errorIsFeatureOff = computed(() => isFeatureOff(guidedError.value));
const showFeatureOff = computed(() => flagOff.value || errorIsFeatureOff.value);

const guidedSorted = computed(() => {
  const items = guidedRuns.value ?? [];
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
});

function openGuided(id: string): void {
  router.push(`/discovery/guided/${id}`);
}

// ─── legacy single-niche search (advanced/debug) ───
const singleQuery = ref('');
const singlePlatform = ref<string>('');
const singleLimit = ref<string>('20');
const singleResult = ref<DiscoveryResult | null>(null);

const singleMut = useMutation({
  mutationFn: () =>
    api.post<DiscoveryResult>('/discovery/search', {
      query: singleQuery.value.trim(),
      ...(singlePlatform.value ? { platform: singlePlatform.value as Platform } : {}),
      limit: clampLimit(singleLimit.value),
    }),
  onSuccess: (r) => {
    singleResult.value = r;
    qc.invalidateQueries({ queryKey: ['discovery-batches'] });
    toast.success(`Найдено: ${r.candidates.length} (новых ${r.created})`);
  },
  onError: (e: Error) => toast.error('Поиск не удался', e.message),
});

const singleValid = computed(() => singleQuery.value.trim().length >= 2);

function submitSingle(): void {
  if (!singleValid.value || singleMut.isPending.value) return;
  singleMut.mutate();
}

// ─── legacy batch search (advanced/debug) ───
const batchRaw = ref('');
const batchPlatform = ref<string>('');
const batchLimit = ref<string>('20');

const batchQueries = computed(() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of batchRaw.value.split(/\r?\n/)) {
    const q = line.trim();
    if (q.length < 2 || seen.has(q)) continue;
    seen.add(q);
    out.push(q);
  }
  return out;
});

const batchOverflow = computed(() => batchQueries.value.length > 50);
const batchValid = computed(() => batchQueries.value.length >= 1 && !batchOverflow.value);

const batchMut = useMutation({
  mutationFn: () =>
    api.post<{ id: string }>('/discovery/batch', {
      queries: batchQueries.value,
      ...(batchPlatform.value ? { platform: batchPlatform.value as Platform } : {}),
      limit_per_query: clampLimit(batchLimit.value),
    }),
  onSuccess: ({ id }) => {
    qc.invalidateQueries({ queryKey: ['discovery-batches'] });
    toast.success('Batch создан');
    router.push(`/discovery/batches/${id}`);
  },
  onError: (e: Error) => toast.error('Не удалось создать batch', e.message),
});

function submitBatch(): void {
  if (!batchValid.value || batchMut.isPending.value) return;
  batchMut.mutate();
}

// ─── legacy recent batches (advanced/debug) ───
const { data: batches, isLoading: batchesLoading } = useQuery({
  queryKey: ['discovery-batches'],
  queryFn: () => api.get<DiscoveryBatchListItem[]>('/discovery/batch'),
  enabled: computed(() => !flagOff.value),
  retry: false,
});

const batchesSorted = computed(() => {
  const items = batches.value ?? [];
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
});

function platformLabel(p: Platform | null | undefined): string {
  return p ?? 'all';
}
</script>

<template>
  <PageHead title="Discovery" sub="AJTBD-направляемый поиск блогеров с разбором и рекомендациями" />

  <FeatureOff v-if="showFeatureOff" flag="channel_discovery" />

  <div v-else class="cards" style="grid-template-columns: 1fr;">
    <!-- ─── guided workbench input ─── -->
    <div class="card">
      <div class="card-head">
        <Icon name="zap" :size="12" /><span>Новый поиск</span>
        <span class="muted-2" style="margin-left: 6px;">кампания или ручной бриф → план запросов → разбор кандидатов</span>
      </div>
      <div class="card-body" style="display: flex; flex-direction: column; gap: 12px;">
        <div style="display: flex; gap: 8px;">
          <button
            class="btn"
            :class="guidedMode === 'manual' ? 'accent' : ''"
            @click="guidedMode = 'manual'"
          >
            Ручной бриф
          </button>
          <button
            class="btn"
            :class="guidedMode === 'campaign' ? 'accent' : ''"
            @click="guidedMode = 'campaign'"
          >
            Из кампании
          </button>
        </div>

        <Field
          v-if="guidedMode === 'manual'"
          label="Бриф / AJTBD"
          help="Опишите нишу и кого ищем — например: «B2B финтех-основатели в Telegram»"
        >
          <TextareaInput
            v-model="guidedBrief"
            :rows="4"
            placeholder="B2B финтех-основатели в Telegram: каналы про привлечение инвестиций, продуктовый рост, метрики"
            :disabled="guidedMut.isPending.value"
          />
        </Field>

        <Field v-else label="Кампания" help="Цель/AJTBD кампании станут брифом поиска">
          <SelectInput v-model="guidedCampaignId" :options="campaignOpts" />
        </Field>

        <div style="display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: end;">
          <Field label="Платформа">
            <SelectInput v-model="guidedPlatform" :options="PLATFORM_OPTS" />
          </Field>
          <button
            class="btn accent"
            :disabled="!guidedValid || guidedMut.isPending.value"
            @click="submitGuided"
          >
            <span v-if="guidedMut.isPending.value" class="spinner" />
            <Icon v-else name="zap" :size="12" /><span>Запустить поиск</span>
          </button>
        </div>
      </div>
    </div>

    <!-- ─── guided runs ─── -->
    <div class="card">
      <div class="card-head">
        <Icon name="list" :size="12" /><span>Запуски</span>
        <span class="muted-2" style="margin-left: 6px;">{{ guidedSorted.length }}</span>
      </div>
      <div class="card-body">
        <div v-if="guidedLoading" class="center" style="padding: 16px;"><Spinner /></div>
        <EmptyState
          v-else-if="guidedError && !errorIsFeatureOff"
          title="Не удалось загрузить запуски"
          icon="warn"
          :description="guidedError instanceof ApiError ? guidedError.message : 'Неизвестная ошибка'"
        />
        <div v-else-if="guidedSorted.length === 0" class="placeholder" style="min-height: 64px;">
          Пока пусто. Запустите первый поиск выше.
        </div>
        <table v-else class="tbl">
          <thead>
            <tr>
              <th>ID</th>
              <th>Статус</th>
              <th>Бриф</th>
              <th>Платформа</th>
              <th class="num">Найдено</th>
              <th class="num">Рекоменд.</th>
              <th class="num">Разобрано</th>
              <th>Создан</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in guidedSorted" :key="r.id" style="cursor: pointer;" @click="openGuided(r.id)">
              <td class="mono" style="font-size: 11px;">{{ r.id.slice(0, 8) }}…</td>
              <td><Pill :cls="guidedStatusPill(r.status)">{{ r.status }}</Pill></td>
              <td class="muted" style="font-size: 12px; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{ r.briefPreview || '—' }}</td>
              <td class="mono" style="font-size: 11.5px;">{{ platformLabel(r.platform) }}</td>
              <td class="num mono">{{ formatNumber(r.summary.candidatesFound) }}</td>
              <td class="num mono" style="color: var(--ok);">{{ formatNumber(r.summary.recommended) }}</td>
              <td class="num mono">{{ formatNumber(r.summary.candidatesReviewed) }}</td>
              <td class="muted-2" style="font-size: 11px;">{{ formatDateTime(r.createdAt) }}</td>
              <td><button class="btn" aria-label="Открыть запуск" title="Открыть запуск" @click.stop="openGuided(r.id)"><Icon name="arrow_right" :size="12" /></button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ─── advanced / legacy raw search ─── -->
    <details class="card">
      <summary class="card-head" style="cursor: pointer; list-style: revert;">
        <Icon name="search" :size="12" /><span>Низкоуровневый поиск (отладка)</span>
        <span class="muted-2" style="margin-left: 6px;">прямой web-search без планировщика/разбора</span>
      </summary>
      <div class="card-body" style="display: flex; flex-direction: column; gap: 12px;">
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <!-- single -->
          <div class="card">
            <div class="card-head"><Icon name="search" :size="12" /><span>Один запрос</span></div>
            <div class="card-body" style="display: flex; flex-direction: column; gap: 12px;">
              <Field label="Ниша" help="2–300 символов">
                <TextInput v-model="singleQuery" :maxlength="300" placeholder="ленивые завтраки на сковородке" :disabled="singleMut.isPending.value" />
              </Field>
              <div style="display: grid; grid-template-columns: 1fr 120px; gap: 8px;">
                <Field label="Платформа"><SelectInput v-model="singlePlatform" :options="PLATFORM_OPTS" /></Field>
                <Field label="Лимит" help="1–50"><TextInput v-model="singleLimit" type="number" mono /></Field>
              </div>
              <div>
                <button class="btn" :disabled="!singleValid || singleMut.isPending.value" @click="submitSingle">
                  <span v-if="singleMut.isPending.value" class="spinner" />
                  <Icon v-else name="search" :size="12" /><span>Найти</span>
                </button>
              </div>
              <div v-if="singleResult" style="border-top: 1px solid var(--line); padding-top: 10px; font-size: 12px;">
                <span class="muted-2">Кандидатов:</span> <span class="mono cell-strong">{{ formatNumber(singleResult.candidates.length) }}</span>
                · <span class="muted-2">новых:</span> <span class="mono" style="color: var(--ok);">{{ formatNumber(singleResult.created) }}</span>
                · <span class="muted-2">знаем:</span> <span class="mono">{{ formatNumber(singleResult.alreadyKnown) }}</span>
              </div>
            </div>
          </div>
          <!-- batch -->
          <div class="card">
            <div class="card-head"><Icon name="layers" :size="12" /><span>Batch</span></div>
            <div class="card-body" style="display: flex; flex-direction: column; gap: 12px;">
              <Field
                label="Ниши (по одной в строке)"
                :help="`${batchQueries.length} ниш${batchOverflow ? ' — превышен лимит 50' : ''}`"
                :error="batchOverflow ? 'Не больше 50 ниш в batch' : null"
              >
                <TextareaInput v-model="batchRaw" :rows="6" mono :error="batchOverflow" :disabled="batchMut.isPending.value" />
              </Field>
              <div style="display: grid; grid-template-columns: 1fr 140px; gap: 8px;">
                <Field label="Платформа"><SelectInput v-model="batchPlatform" :options="PLATFORM_OPTS" /></Field>
                <Field label="Лимит / нишу" help="1–50"><TextInput v-model="batchLimit" type="number" mono /></Field>
              </div>
              <div>
                <button class="btn" :disabled="!batchValid || batchMut.isPending.value" @click="submitBatch">
                  <span v-if="batchMut.isPending.value" class="spinner" />
                  <Icon v-else name="zap" :size="12" /><span>Запустить batch</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- recent batches -->
        <div class="card">
          <div class="card-head"><Icon name="list" :size="12" /><span>Recent batches</span><span class="muted-2" style="margin-left: 6px;">{{ batchesSorted.length }}</span></div>
          <div class="card-body">
            <div v-if="batchesLoading" class="center" style="padding: 16px;"><Spinner /></div>
            <div v-else-if="batchesSorted.length === 0" class="placeholder" style="min-height: 48px;">Пока ничего.</div>
            <table v-else class="tbl">
              <thead>
                <tr><th>ID</th><th>Статус</th><th>Создан</th><th>Платформа</th><th class="num">Ниш</th><th class="num">Новых</th><th></th></tr>
              </thead>
              <tbody>
                <tr v-for="b in batchesSorted" :key="b.id" style="cursor: pointer;" @click="router.push(`/discovery/batches/${b.id}`)">
                  <td class="mono" style="font-size: 11px;">{{ b.id.slice(0, 8) }}…</td>
                  <td><Pill :cls="guidedStatusPill(b.status)">{{ b.status }}</Pill></td>
                  <td class="muted-2" style="font-size: 11px;">{{ formatDateTime(b.createdAt) }}</td>
                  <td class="mono" style="font-size: 11.5px;">{{ platformLabel(b.platform) }}</td>
                  <td class="num mono">{{ formatNumber(b.totals.queries) }}</td>
                  <td class="num mono" style="color: var(--ok);">{{ formatNumber(b.totals.created) }}</td>
                  <td><button class="btn" aria-label="Открыть batch" @click.stop="router.push(`/discovery/batches/${b.id}`)"><Icon name="arrow_right" :size="12" /></button></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </details>
  </div>
</template>
