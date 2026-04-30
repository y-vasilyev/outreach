<script setup lang="ts">
import { computed, ref } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import PageHead from '../../components/PageHead.vue';
import Tabs from '../../components/Tabs.vue';
import FilterBar from '../../components/FilterBar.vue';
import Chip from '../../components/Chip.vue';
import Pill from '../../components/Pill.vue';
import Avatar from '../../components/Avatar.vue';
import Bar from '../../components/Bar.vue';
import Icon from '../../components/Icon.vue';
import Spinner from '../../components/Spinner.vue';
import EmptyState from '../../components/EmptyState.vue';
import Dropdown from '../../components/Dropdown.vue';
import ConfirmDialog from '../../components/ConfirmDialog.vue';
import TgAccountForm from './TgAccountForm.vue';
import TgLoginDialog from './TgLoginDialog.vue';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { initials, formatRelative, formatNumber } from '../../lib/format';
import { avatarColor } from '../../lib/state';
import type { TgAccount } from './types';

const qc = useQueryClient();

const tab = ref<'all' | 'outreach' | 'parser'>('all');
const stateFilter = ref<'' | 'active' | 'warmup' | 'cooldown' | 'banned' | 'need_auth'>('');

const formOpen = ref(false);
const editing = ref<TgAccount | null>(null);
const loginFor = ref<TgAccount | null>(null);
const deleteFor = ref<TgAccount | null>(null);

const { data, isLoading } = useQuery({
  queryKey: ['tg-accounts'],
  queryFn: () => api.get<TgAccount[]>('/tg-accounts'),
});

const list = computed<TgAccount[]>(() => data.value ?? []);

const filtered = computed<TgAccount[]>(() => {
  let xs = list.value;
  if (tab.value !== 'all') xs = xs.filter((a) => a.role === tab.value || a.role === 'both');
  if (stateFilter.value) xs = xs.filter((a) => a.status === stateFilter.value);
  return xs;
});

const counts = computed(() => ({
  all: list.value.length,
  outreach: list.value.filter((a) => a.role === 'outreach' || a.role === 'both').length,
  parser: list.value.filter((a) => a.role === 'parser' || a.role === 'both').length,
}));

const tabsList = computed(() => [
  { id: 'all', label: 'Все', count: counts.value.all },
  { id: 'outreach', label: 'Outreach', count: counts.value.outreach },
  { id: 'parser', label: 'Parser', count: counts.value.parser },
]);

const delMut = useMutation({
  mutationFn: (id: string) => api.del<void>(`/tg-accounts/${id}`),
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: ['tg-accounts'] });
    toast.success('Аккаунт удалён');
    deleteFor.value = null;
  },
  onError: (e: Error) => toast.error('Не удалось удалить', e.message),
});

const pauseMut = useMutation({
  mutationFn: (id: string) => api.patch<void>(`/tg-accounts/${id}`, { status: 'idle' }),
  onSuccess: () => { qc.invalidateQueries({ queryKey: ['tg-accounts'] }); toast.info('Аккаунт на паузе'); },
});

function openEdit(a: TgAccount): void { editing.value = a; formOpen.value = true; }
function openNew(): void { editing.value = null; formOpen.value = true; }

function dropdownItems(a: TgAccount) {
  return [
    {
      label: a.status === 'need_auth' ? 'Войти заново' : 'Релогин',
      icon: 'key' as const,
      onClick: () => (loginFor.value = a),
    },
    {
      label: 'Редактировать',
      icon: 'edit' as const,
      onClick: () => openEdit(a),
    },
    {
      label: 'Поставить на паузу',
      icon: 'pause_circle' as const,
      onClick: () => pauseMut.mutate(a.id),
    },
    { divider: true, label: '' },
    {
      label: 'Удалить',
      icon: 'trash' as const,
      variant: 'danger' as const,
      onClick: () => (deleteFor.value = a),
    },
  ];
}
</script>

<template>
  <PageHead title="TG-аккаунты" :sub="`${counts.outreach} outreach · ${counts.parser} parser · все под FloodGuard`">
    <template #actions>
      <button class="btn"><Icon name="shield" :size="12" /><span>FloodGuard logs</span></button>
      <button class="btn primary" @click="openNew"><Icon name="plus" :size="12" /><span>Подключить аккаунт</span></button>
    </template>
  </PageHead>
  <Tabs :tabs="tabsList" :active="tab" @change="(id) => (tab = id as any)" />
  <FilterBar>
    <Chip
      label="Состояние"
      :value="stateFilter || 'любое'"
      :applied="!!stateFilter"
      removable
      @click="
        stateFilter =
          stateFilter === '' ? 'active'
          : stateFilter === 'active' ? 'warmup'
          : stateFilter === 'warmup' ? 'cooldown'
          : stateFilter === 'cooldown' ? 'need_auth'
          : ('' as any)
      "
      @remove="stateFilter = ''"
    />
    <template #right>
      <span class="muted-2">{{ filtered.length }} из {{ list.length }}</span>
    </template>
  </FilterBar>

  <div v-if="isLoading" class="center"><Spinner /></div>
  <EmptyState
    v-else-if="filtered.length === 0"
    title="Аккаунтов нет"
    description="Добавьте парсер-аккаунт для скрейпа и outreach-аккаунт для отправки."
    icon="send"
  >
    <template #action>
      <button class="btn primary" @click="openNew"><Icon name="plus" :size="12" /><span>Добавить</span></button>
    </template>
  </EmptyState>
  <div v-else class="table-wrap">
    <table class="tbl">
      <thead>
        <tr>
          <th>Аккаунт</th>
          <th>Роль</th>
          <th>Состояние</th>
          <th>Warmup</th>
          <th>Сегодня</th>
          <th>Cooldown</th>
          <th>Подключён</th>
          <th style="width: 160px;"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="a in filtered" :key="a.id">
          <td>
            <div style="display: flex; align-items: center; gap: 9px;">
              <Avatar :text="initials(a.label)" :color="avatarColor(a.id)" />
              <div>
                <div class="cell-strong">{{ a.label }}</div>
                <div class="mono muted-2" style="font-size: 10.5px;">{{ a.phone }}</div>
              </div>
            </div>
          </td>
          <td>
            <Pill v-if="a.role === 'parser'" cls="violet" :label="'parser'" :dot="false" />
            <Pill v-else-if="a.role === 'both'" cls="violet" :label="'both'" :dot="false" />
            <Pill v-else cls="accent" :label="'outreach'" :dot="false" />
          </td>
          <td>
            <div style="display: flex; align-items: center; gap: 6px;">
              <Pill :state="a.status" />
              <span v-if="a.status === 'cooldown' && a.cooldownUntil" class="muted-2 mono" style="font-size: 10.5px;">до {{ formatRelative(a.cooldownUntil) }}</span>
            </div>
          </td>
          <td>
            <div style="display: flex; align-items: center; gap: 6px;">
              <Bar :value="a.warmupStage / 4" :width="60" />
              <span class="mono muted-2" style="font-size: 10.5px;">{{ a.warmupStage }}/4</span>
            </div>
          </td>
          <td>
            <div style="font-size: 11px; color: var(--ink-3);">
              <div>msg <span class="mono cell-strong">{{ formatNumber(a.sentTodayMsg) }}</span> / {{ formatNumber(a.dailyMsgLimit) }}</div>
              <div>new <span class="mono cell-strong">{{ formatNumber(a.sentTodayNew) }}</span> / {{ formatNumber(a.dailyNewContactLimit) }}</div>
            </div>
          </td>
          <td>
            <span v-if="a.cooldownUntil" class="mono" style="color: var(--bad);">{{ formatRelative(a.cooldownUntil) }}</span>
            <span v-else class="muted-2">—</span>
          </td>
          <td class="muted-2 mono" style="font-size: 10.5px;">{{ formatRelative(a.createdAt) }}</td>
          <td>
            <div style="display: flex; gap: 4px; justify-content: flex-end;">
              <button v-if="a.status === 'need_auth'" class="btn sm" @click="loginFor = a">
                <Icon name="key" :size="11" /><span>Войти</span>
              </button>
              <Dropdown :items="dropdownItems(a)" align="right">
                <button class="btn ghost icon-only sm"><Icon name="more" :size="12" /></button>
              </Dropdown>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <TgAccountForm
    :open="formOpen"
    :account="editing"
    @close="formOpen = false"
    @saved="(acc) => { qc.invalidateQueries({ queryKey: ['tg-accounts'] }); formOpen = false; if (!editing) loginFor = acc; }"
  />
  <TgLoginDialog
    v-if="loginFor"
    :open="!!loginFor"
    :account="loginFor"
    @close="loginFor = null"
    @done="() => { qc.invalidateQueries({ queryKey: ['tg-accounts'] }); loginFor = null; }"
  />
  <ConfirmDialog
    :open="!!deleteFor"
    title="Удалить TG аккаунт?"
    :description="deleteFor ? `Аккаунт «${deleteFor.label}» будет отключён. Активные диалоги перейдут в режим manual.` : ''"
    confirm-label="Удалить"
    destructive
    :loading="delMut.isPending.value"
    @close="deleteFor = null"
    @confirm="deleteFor && delMut.mutate(deleteFor.id)"
  />
</template>
