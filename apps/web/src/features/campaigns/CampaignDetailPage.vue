<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import PageHead from '../../components/PageHead.vue';
import Pill from '../../components/Pill.vue';
import Icon from '../../components/Icon.vue';
import Spinner from '../../components/Spinner.vue';
import KeyValue, { type KvItem } from '../../components/KeyValue.vue';
import Modal from '../../components/Modal.vue';
import CampaignForm from './CampaignForm.vue';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { formatNumber } from '../../lib/format';
import type { Campaign, CampaignPreviewItem } from './types';

const route = useRoute();
const router = useRouter();
const qc = useQueryClient();

const id = computed(() => route.params.id as string);

const editOpen = ref(false);
const previewOpen = ref(false);
const preview = ref<CampaignPreviewItem[]>([]);

const { data: campaign, isLoading } = useQuery({
  queryKey: ['campaign', id],
  queryFn: () => api.get<Campaign>(`/campaigns/${id.value}`),
  enabled: computed(() => !!id.value),
});

const runMut = useMutation({
  mutationFn: () => api.post<void>(`/campaigns/${id.value}/run`, {}),
  onSuccess: () => { qc.invalidateQueries({ queryKey: ['campaign', id.value] }); toast.success('Кампания запущена'); },
});
const pauseMut = useMutation({
  mutationFn: () => api.post<void>(`/campaigns/${id.value}/pause`, {}),
  onSuccess: () => { qc.invalidateQueries({ queryKey: ['campaign', id.value] }); toast.info('Кампания на паузе'); },
});
const previewMut = useMutation({
  mutationFn: () => api.post<{ items: CampaignPreviewItem[] }>(`/campaigns/${id.value}/preview`, { limit: 5 }),
  onSuccess: (r) => { preview.value = r.items ?? []; previewOpen.value = true; },
  onError: (e: Error) => toast.error('Не удалось собрать превью', e.message),
});

const goalKv = computed<KvItem[]>(() => {
  const c = campaign.value;
  if (!c) return [];
  return [
    { label: 'Цель', value: c.goalText },
    { label: 'Длительность', value: '20 минут' },
    { label: 'Value-prop', value: c.valueProp },
  ];
});

const sendingKv = computed<KvItem[]>(() => {
  const c = campaign.value;
  if (!c) return [];
  const sched = c.schedule;
  return [
    { label: 'Канал', value: 'Telegram (only)' },
    { label: 'Аккаунты', value: c.outreachAccountPool?.length ? `${c.outreachAccountPool.length} в пуле` : 'не задан' },
    { label: 'Лимит / день', value: sched?.maxPerDayPerAccount ? String(sched.maxPerDayPerAccount) : '—', mono: true },
    {
      label: 'Окно',
      value: sched?.workHours ? `${sched.workHours.start}–${sched.workHours.end} · ${sched.tz ?? 'UTC'}` : '—',
    },
  ];
});

const replyRate = computed(() => {
  const m = campaign.value?.metrics;
  if (!m) return 0;
  return m.sent ? m.replies / m.sent : 0;
});

const stats = computed(() => {
  const c = campaign.value;
  if (!c) return [] as Array<{ l: string; v: number; sub: string; color?: string }>;
  return [
    { l: 'Каналов', v: c.outreachAccountPool?.length ?? 0, sub: 'после фильтра' },
    { l: 'Отправлено', v: c.metrics?.sent ?? 0, sub: 'за всё время' },
    { l: 'Ответили', v: c.metrics?.replies ?? 0, sub: `${(replyRate.value * 100).toFixed(0)}% reply rate`, color: 'var(--ok)' },
    { l: 'Запланировано', v: c.metrics?.qualified ?? 0, sub: 'qualified', color: 'var(--violet)' },
    { l: 'В очереди', v: 0, sub: 'next 24h' },
  ];
});
</script>

<template>
  <PageHead :title="campaign?.name ?? 'Кампания'" :sub="campaign?.goalText">
    <template #actions>
      <button class="btn" @click="router.push('/campaigns')"><Icon name="arrow_left" :size="12" /><span>Все кампании</span></button>
      <button class="btn" :disabled="previewMut.isPending.value" @click="previewMut.mutate()">
        <span v-if="previewMut.isPending.value" class="spinner" />
        <Icon v-else name="eye" :size="12" /><span>Превью первых сообщений</span>
      </button>
      <button class="btn" @click="editOpen = true"><Icon name="edit" :size="12" /><span>Редактировать</span></button>
      <button v-if="campaign?.status === 'running'" class="btn" :disabled="pauseMut.isPending.value" @click="pauseMut.mutate()">
        <Icon name="pause" :size="11" /><span>Пауза</span>
      </button>
      <button v-else class="btn accent" :disabled="runMut.isPending.value" @click="runMut.mutate()">
        <Icon name="play" :size="11" /><span>Запустить отправку</span>
      </button>
    </template>
  </PageHead>

  <div v-if="isLoading || !campaign" class="center"><Spinner /></div>
  <div v-else class="cards" style="grid-template-columns: 1fr;">
    <div style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px;">
      <div v-for="(s, i) in stats" :key="i" class="card">
        <div style="padding: 10px 12px;">
          <div style="font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-4); font-weight: 500;">{{ s.l }}</div>
          <div :style="{ fontSize: '22px', fontWeight: 600, marginTop: '4px', fontFamily: 'var(--font-mono)', letterSpacing: '-0.02em', color: s.color || 'var(--ink)' }">{{ formatNumber(s.v) }}</div>
          <div class="muted-2" style="font-size: 11px;">{{ s.sub }}</div>
        </div>
      </div>
    </div>

    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
      <div class="card">
        <div class="card-head"><Icon name="flag" :size="12" /><span>Цель и value-prop</span></div>
        <div class="card-body"><KeyValue :items="goalKv" /></div>
      </div>
      <div class="card">
        <div class="card-head"><Icon name="filter" :size="12" /><span>Фильтр аудитории (JSON)</span></div>
        <pre class="card-body mono" style="margin: 0; padding: 12px; max-height: 240px; overflow: auto; font-size: 11px;">{{ JSON.stringify(campaign.targetFilter ?? {}, null, 2) }}</pre>
      </div>
      <div class="card">
        <div class="card-head"><Icon name="send" :size="12" /><span>Отправка</span></div>
        <div class="card-body"><KeyValue :items="sendingKv" /></div>
      </div>
      <div class="card">
        <div class="card-head"><Icon name="bot" :size="12" /><span>Agent overrides (JSON)</span></div>
        <pre class="card-body mono" style="margin: 0; padding: 12px; max-height: 240px; overflow: auto; font-size: 11px;">{{ JSON.stringify(campaign.agentOverrides ?? {}, null, 2) }}</pre>
      </div>
    </div>
  </div>

  <CampaignForm
    :open="editOpen"
    :campaign="campaign ?? null"
    @close="editOpen = false"
    @saved="() => { editOpen = false; qc.invalidateQueries({ queryKey: ['campaign', id] }); qc.invalidateQueries({ queryKey: ['campaigns'] }); }"
  />

  <Modal :open="previewOpen" size="xl" title="Превью первых сообщений" description="Драфты от OpeningComposer + проверка SafetyFilter. Кампания не запущена." @close="previewOpen = false">
    <div v-if="preview.length === 0" class="center"><span>Нет кандидатов под текущий фильтр.</span></div>
    <div v-else style="display: flex; flex-direction: column; gap: 12px;">
      <div v-for="p in preview" :key="p.contactId" style="border: 1px solid var(--line); border-radius: var(--r-md); padding: 12px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div class="mono cell-strong">{{ p.contactValue }}</div>
          <div v-if="p.channelTitle" class="muted-2" style="font-size: 11px;">{{ p.channelTitle }}</div>
        </div>
        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 10px;">
          <div v-for="(d, i) in p.drafts" :key="i" style="background: var(--paper-2); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 10px;">
            <div style="font-size: 12.5px; white-space: pre-wrap; color: var(--ink-2);">{{ d.text }}</div>
            <div v-if="d.riskScore != null" class="muted-2" style="font-size: 10.5px; margin-top: 4px;">
              risk: {{ (d.riskScore * 100).toFixed(0) }}%<span v-if="d.rationale"> · {{ d.rationale }}</span>
            </div>
          </div>
        </div>
        <div v-if="p.blocked" style="margin-top: 6px; font-size: 11px; color: var(--bad);">
          Заблокировано SafetyFilter: {{ p.blocked.reasons.join(', ') }}
        </div>
      </div>
    </div>
    <template #footer>
      <button class="btn" @click="previewOpen = false">Закрыть</button>
    </template>
  </Modal>
</template>
