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
import type {
  DiscoveryBatchListItem,
  DiscoveryResult,
  Platform,
} from './types';

const router = useRouter();
const qc = useQueryClient();
const flags = useFlags();

// Two-layer feature gate: hide entirely when the flag snapshot reports off,
// AND treat a non-application 404 on the batches list as feature-off (the
// flag may flip between fetch and navigation; route stays unregistered then).
const flagOff = computed(() => flags.value.channelDiscovery === false);

const PLATFORM_OPTS = [
  { value: '', label: 'Все платформы' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'youtube', label: 'YouTube' },
];

// ─── single-niche search ───
// Limit refs are stored as `string` because `TextInput type="number"` emits
// the raw HTMLInputElement value (string). We coerce + clamp at send time —
// the backend schema is `number().int().min(1).max(50)`.
const singleQuery = ref('');
const singlePlatform = ref<string>('');
const singleLimit = ref<string>('20');
const singleResult = ref<DiscoveryResult | null>(null);

function clampLimit(raw: string, fallback = 20): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(50, n));
}

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

// ─── batch search ───
const batchRaw = ref('');
const batchPlatform = ref<string>('');
const batchLimit = ref<string>('20');

// Lines → trimmed niche list, dedup, empty drop. Backend caps at 50; we mirror.
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

// ─── recent batches ───
const {
  data: batches,
  isLoading: batchesLoading,
  error: batchesError,
} = useQuery({
  queryKey: ['discovery-batches'],
  queryFn: () => api.get<DiscoveryBatchListItem[]>('/discovery/batch'),
  enabled: computed(() => !flagOff.value),
  retry: false,
});

const errorIsFeatureOff = computed(() => isFeatureOff(batchesError.value));
const showFeatureOff = computed(() => flagOff.value || errorIsFeatureOff.value);

const batchesSorted = computed(() => {
  const items = batches.value ?? [];
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
});

function openBatch(id: string): void {
  router.push(`/discovery/batches/${id}`);
}

function platformLabel(p: Platform | null | undefined): string {
  if (!p) return 'all';
  return p;
}

// Map backend status to the existing pill tone vocabulary.
function statusPill(s: DiscoveryBatchListItem['status']): 'ghost' | 'accent' | 'ok' | 'bad' {
  if (s === 'done') return 'ok';
  if (s === 'failed') return 'bad';
  if (s === 'running') return 'accent';
  return 'ghost';
}
</script>

<template>
  <PageHead title="Discovery" sub="Поиск каналов по нишам через web search (Yandex)" />

  <FeatureOff v-if="showFeatureOff" flag="channel_discovery" />

  <!-- Single `.cards` scroll wrapper for the whole page — `.main` clips
       overflow, so direct siblings under it lose padding and scroll once
       the recent-batches table grows. -->
  <div v-else class="cards" style="grid-template-columns: 1fr;">
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
      <!-- ─── single-niche ─── -->
      <div class="card">
        <div class="card-head"><Icon name="search" :size="12" /><span>Один запрос</span></div>
        <div class="card-body" style="display: flex; flex-direction: column; gap: 12px;">
          <Field label="Ниша" help="2–300 символов; одно ключевое словосочетание">
            <TextInput v-model="singleQuery" :maxlength="300" placeholder="ленивые завтраки на сковородке" :disabled="singleMut.isPending.value" />
          </Field>
          <div style="display: grid; grid-template-columns: 1fr 120px; gap: 8px;">
            <Field label="Платформа">
              <SelectInput v-model="singlePlatform" :options="PLATFORM_OPTS" />
            </Field>
            <Field label="Лимит" help="1–50">
              <TextInput v-model="singleLimit" type="number" mono />
            </Field>
          </div>
          <div>
            <button
              class="btn accent"
              :disabled="!singleValid || singleMut.isPending.value"
              @click="submitSingle"
            >
              <span v-if="singleMut.isPending.value" class="spinner" />
              <Icon v-else name="search" :size="12" /><span>Найти</span>
            </button>
          </div>

          <div v-if="singleResult" style="border-top: 1px solid var(--line); padding-top: 10px;">
            <div style="display: flex; gap: 12px; margin-bottom: 8px; font-size: 12px;">
              <span><span class="muted-2">Кандидатов:</span> <span class="mono cell-strong">{{ formatNumber(singleResult.candidates.length) }}</span></span>
              <span><span class="muted-2">Новых:</span> <span class="mono cell-strong" style="color: var(--ok);">{{ formatNumber(singleResult.created) }}</span></span>
              <span><span class="muted-2">Уже знаем:</span> <span class="mono">{{ formatNumber(singleResult.alreadyKnown) }}</span></span>
              <span><span class="muted-2">В очередь scrape:</span> <span class="mono">{{ formatNumber(singleResult.enqueued) }}</span></span>
            </div>
            <table v-if="singleResult.candidates.length" class="tbl">
              <thead>
                <tr><th>Платформа</th><th>Handle</th><th>Заголовок</th><th></th></tr>
              </thead>
              <tbody>
                <tr v-for="(c, i) in singleResult.candidates" :key="i">
                  <td class="mono" style="font-size: 11.5px;">{{ c.platform }}</td>
                  <td class="cell-strong mono">{{ c.handle }}</td>
                  <td class="muted" style="font-size: 12px;">{{ c.title || '—' }}</td>
                  <td>
                    <span v-if="c.alreadyKnown" class="pill ghost"><span class="dot" />есть</span>
                    <span v-else class="pill ok"><span class="dot" />новый</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- ─── batch ─── -->
      <div class="card">
        <div class="card-head">
          <Icon name="layers" :size="12" /><span>Batch</span>
          <span class="muted-2" style="margin-left: 6px;">до 50 ниш; обрабатываются worker-ом по одной</span>
        </div>
        <div class="card-body" style="display: flex; flex-direction: column; gap: 12px;">
          <Field
            label="Ниши (по одной в строке)"
            :help="`${batchQueries.length} ниш${batchOverflow ? ' — превышен лимит 50, отправка заблокирована' : ''}`"
            :error="batchOverflow ? 'Не больше 50 ниш в batch' : null"
          >
            <TextareaInput
              v-model="batchRaw"
              :rows="8"
              mono
              :error="batchOverflow"
              placeholder="ленивые завтраки на сковородке&#10;диетические супы&#10;домашние десерты без сахара"
              :disabled="batchMut.isPending.value"
            />
          </Field>
          <div style="display: grid; grid-template-columns: 1fr 140px; gap: 8px;">
            <Field label="Платформа">
              <SelectInput v-model="batchPlatform" :options="PLATFORM_OPTS" />
            </Field>
            <Field label="Лимит / нишу" help="1–50">
              <TextInput v-model="batchLimit" type="number" mono />
            </Field>
          </div>
          <div>
            <button
              class="btn accent"
              :disabled="!batchValid || batchMut.isPending.value"
              @click="submitBatch"
            >
              <span v-if="batchMut.isPending.value" class="spinner" />
              <Icon v-else name="zap" :size="12" /><span>Запустить batch</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ─── recent batches ─── -->
    <div class="card">
      <div class="card-head">
        <Icon name="list" :size="12" /><span>Recent batches</span>
        <span class="muted-2" style="margin-left: 6px;">{{ batchesSorted.length }}</span>
      </div>
      <div class="card-body">
        <div v-if="batchesLoading" class="center" style="padding: 16px;"><Spinner /></div>
        <EmptyState
          v-else-if="batchesError && !errorIsFeatureOff"
          title="Не удалось загрузить список"
          icon="warn"
          :description="batchesError instanceof ApiError ? batchesError.message : 'Неизвестная ошибка'"
        />
        <div v-else-if="batchesSorted.length === 0" class="placeholder" style="min-height: 64px;">
          Пока ничего. Запустите первый batch выше.
        </div>
        <table v-else class="tbl">
          <thead>
            <tr>
              <th>ID</th>
              <th>Статус</th>
              <th>Создан</th>
              <th>Платформа</th>
              <th class="num">Ниш</th>
              <th class="num">Готово</th>
              <th class="num">Новых</th>
              <th class="num">Знаем</th>
              <th class="num">Ошибок</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="b in batchesSorted" :key="b.id" @click="openBatch(b.id)" style="cursor: pointer;">
              <td class="mono" style="font-size: 11px;">{{ b.id.slice(0, 8) }}…</td>
              <td><Pill :cls="statusPill(b.status)">{{ b.status }}</Pill></td>
              <td class="muted-2" style="font-size: 11px;">{{ formatDateTime(b.createdAt) }}</td>
              <td class="mono" style="font-size: 11.5px;">{{ platformLabel(b.platform) }}</td>
              <td class="num mono">{{ formatNumber(b.totals.queries) }}</td>
              <td class="num mono">{{ formatNumber(b.totals.processed) }}</td>
              <td class="num mono" style="color: var(--ok);">{{ formatNumber(b.totals.created) }}</td>
              <td class="num mono">{{ formatNumber(b.totals.alreadyKnown) }}</td>
              <td class="num mono" :style="b.totals.errored > 0 ? 'color: var(--bad);' : ''">{{ formatNumber(b.totals.errored) }}</td>
              <td><button class="btn" aria-label="Открыть batch" title="Открыть batch" @click.stop="openBatch(b.id)"><Icon name="arrow_right" :size="12" /></button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
