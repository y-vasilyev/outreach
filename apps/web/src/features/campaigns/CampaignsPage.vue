<script setup lang="ts">
import { computed, ref } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { useRouter } from 'vue-router';
import PageHead from '../../components/PageHead.vue';
import Pill from '../../components/Pill.vue';
import Icon from '../../components/Icon.vue';
import Spinner from '../../components/Spinner.vue';
import EmptyState from '../../components/EmptyState.vue';
import CampaignForm from './CampaignForm.vue';
import { api } from '../../lib/api';
import { useFlags } from '../../lib/config';
import { toast } from '../../lib/toast';
import { formatNumber, formatPct, formatRelative, truncate } from '../../lib/format';
import type { Campaign } from './types';

const qc = useQueryClient();
const router = useRouter();
const flags = useFlags();

const formOpen = ref(false);
const editing = ref<Campaign | null>(null);

const { data: campaigns, isLoading } = useQuery({
  queryKey: ['campaigns'],
  queryFn: () => api.get<Campaign[]>('/campaigns'),
});

const list = computed<Campaign[]>(() => campaigns.value ?? []);

const runMut = useMutation({
  mutationFn: (id: string) => api.post<void>(`/campaigns/${id}/run`, {}),
  onSuccess: () => { qc.invalidateQueries({ queryKey: ['campaigns'] }); toast.success('Кампания запущена'); },
});
const pauseMut = useMutation({
  mutationFn: (id: string) => api.post<void>(`/campaigns/${id}/pause`, {}),
  onSuccess: () => { qc.invalidateQueries({ queryKey: ['campaigns'] }); toast.info('Кампания на паузе'); },
});

function openEdit(c: Campaign): void { editing.value = c; formOpen.value = true; }
function openNew(): void { editing.value = null; formOpen.value = true; }
</script>

<template>
  <PageHead title="Кампании" :sub="`${list.length} кампаний · ${list.filter((c) => c.status === 'running').length} активных`">
    <template #actions>
      <button v-if="flags.campaignTypes" class="btn" @click="router.push('/campaign-types/new')">
        <Icon name="sparkle" :size="12" /><span>Конструктор типов</span>
      </button>
      <button class="btn primary" @click="openNew">
        <Icon name="plus" :size="12" /><span>Новая кампания</span>
      </button>
    </template>
  </PageHead>

  <div v-if="isLoading" class="center"><Spinner /></div>
  <EmptyState
    v-else-if="list.length === 0"
    title="Кампаний нет"
    description="Создайте первую: цель — CustDev по продукту, фильтр — каналы и роли."
    icon="zap"
  >
    <template #action>
      <button class="btn primary" @click="openNew"><Icon name="plus" :size="12" /><span>Создать</span></button>
    </template>
  </EmptyState>

  <div v-else class="cards" style="grid-template-columns: 1fr 1fr;">
    <div v-for="c in list" :key="c.id" class="card">
      <div class="card-head" style="cursor: pointer;" @click="router.push(`/campaigns/${c.id}`)">
        <span style="font-weight: 500; flex: 1;">{{ c.name }}</span>
        <Pill :state="c.status" />
        <Pill :state="c.defaultMode" />
        <div class="actions">
          <button class="btn ghost icon-only sm" title="Редактировать" @click.stop="openEdit(c)">
            <Icon name="edit" :size="11" />
          </button>
          <button v-if="c.status === 'running'" class="btn sm" :disabled="pauseMut.isPending.value" @click.stop="pauseMut.mutate(c.id)">
            <Icon name="pause" :size="11" /><span>Пауза</span>
          </button>
          <button v-else class="btn primary sm" :disabled="runMut.isPending.value" @click.stop="runMut.mutate(c.id)">
            <Icon name="play" :size="11" /><span>Запустить</span>
          </button>
        </div>
      </div>
      <div class="card-body">
        <p class="muted" style="font-size: 12.5px; line-height: 1.5; margin: 0 0 10px;">{{ truncate(c.goalText, 200) }}</p>
        <div class="muted-2" style="font-size: 11.5px; margin-bottom: 12px;">value-prop: <span style="color: var(--ink-2);">{{ truncate(c.valueProp, 120) }}</span></div>
        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 8px;">
          <div style="padding: 6px 10px; background: var(--paper-2); border: 1px solid var(--line); border-radius: var(--r-sm);">
            <div class="muted-2" style="font-size: 10px; text-transform: uppercase;">Sent</div>
            <div class="mono cell-strong" style="font-size: 14px;">{{ formatNumber(c.metrics?.sent ?? 0) }}</div>
          </div>
          <div style="padding: 6px 10px; background: var(--paper-2); border: 1px solid var(--line); border-radius: var(--r-sm);">
            <div class="muted-2" style="font-size: 10px; text-transform: uppercase;">Replies</div>
            <div class="mono cell-strong" style="font-size: 14px; color: var(--ok);">{{ formatNumber(c.metrics?.replies ?? 0) }}</div>
          </div>
          <div style="padding: 6px 10px; background: var(--paper-2); border: 1px solid var(--line); border-radius: var(--r-sm);">
            <div class="muted-2" style="font-size: 10px; text-transform: uppercase;">Reply-rate</div>
            <div class="mono cell-strong" style="font-size: 14px;">{{ formatPct(c.metrics?.replyRate ?? 0) }}</div>
          </div>
          <div style="padding: 6px 10px; background: var(--paper-2); border: 1px solid var(--line); border-radius: var(--r-sm);">
            <div class="muted-2" style="font-size: 10px; text-transform: uppercase;">Qualified</div>
            <div class="mono cell-strong" style="font-size: 14px; color: var(--violet);">{{ formatNumber(c.metrics?.qualified ?? 0) }}</div>
          </div>
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: var(--ink-3);">
          <span>Обновлена {{ formatRelative(c.updatedAt) }}</span>
          <a class="btn ghost sm" @click="router.push(`/campaigns/${c.id}`)">Подробнее →</a>
        </div>
      </div>
    </div>
  </div>

  <CampaignForm
    :open="formOpen"
    :campaign="editing"
    @close="formOpen = false"
    @saved="() => { formOpen = false; qc.invalidateQueries({ queryKey: ['campaigns'] }); }"
  />
</template>
