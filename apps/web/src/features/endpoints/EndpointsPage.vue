<script setup lang="ts">
import { computed, ref } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import PageHead from '../../components/PageHead.vue';
import Pill from '../../components/Pill.vue';
import Switch from '../../components/Switch.vue';
import Spinner from '../../components/Spinner.vue';
import EmptyState from '../../components/EmptyState.vue';
import Icon from '../../components/Icon.vue';
import KeyValue, { type KvItem } from '../../components/KeyValue.vue';
import ConfirmDialog from '../../components/ConfirmDialog.vue';
import EndpointForm from './EndpointForm.vue';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { formatDateTime } from '../../lib/format';
import type { LLMEndpoint } from './types';

const qc = useQueryClient();

const formOpen = ref(false);
const editing = ref<LLMEndpoint | null>(null);
const deleteFor = ref<LLMEndpoint | null>(null);

const { data, isLoading } = useQuery({
  queryKey: ['endpoints'],
  queryFn: () => api.get<LLMEndpoint[]>('/endpoints'),
});

const list = computed<LLMEndpoint[]>(() => data.value ?? []);

const toggleMut = useMutation({
  mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.patch<LLMEndpoint>(`/endpoints/${id}`, { enabled }),
  onSuccess: () => qc.invalidateQueries({ queryKey: ['endpoints'] }),
});

const delMut = useMutation({
  mutationFn: (id: string) => api.del<void>(`/endpoints/${id}`),
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: ['endpoints'] });
    toast.success('Endpoint удалён');
    deleteFor.value = null;
  },
  onError: (e: Error) => toast.error('Не удалось удалить', e.message),
});

const testMut = useMutation({
  mutationFn: (id: string) => api.post<{ ok: boolean; latencyMs?: number; error?: string }>(`/endpoints/${id}/test`, {}),
  onSuccess: (r) => {
    if (r.ok) toast.success('Endpoint отвечает', r.latencyMs ? `${r.latencyMs} мс` : undefined);
    else toast.error('Endpoint не отвечает', r.error);
  },
});

function openEdit(e: LLMEndpoint): void { editing.value = e; formOpen.value = true; }
function openNew(): void { editing.value = null; formOpen.value = true; }

function endpointKv(e: LLMEndpoint): KvItem[] {
  return [
    { label: 'Провайдер', value: e.provider },
    { label: 'Base URL', value: e.baseUrl, mono: true },
    { label: 'Rate limit (RPM)', value: e.rateLimitRpm != null ? String(e.rateLimitRpm) : '—', mono: true },
    { label: 'Обновлён', value: formatDateTime(e.updatedAt) },
  ];
}
</script>

<template>
  <PageHead title="LLM endpoints" :sub="`${list.length} endpoint-ов · 99.8% uptime`">
    <template #actions>
      <button class="btn primary" @click="openNew">
        <Icon name="plus" :size="12" /><span>Новый endpoint</span>
      </button>
    </template>
  </PageHead>

  <div v-if="isLoading" class="center"><Spinner /></div>
  <EmptyState
    v-else-if="list.length === 0"
    title="Endpoint-ов нет"
    description="Создайте подключение к Yandex или OpenRouter, чтобы агенты могли работать."
    icon="database"
  >
    <template #action>
      <button class="btn primary" @click="openNew"><Icon name="plus" :size="12" /><span>Добавить</span></button>
    </template>
  </EmptyState>

  <div v-else class="cards" style="grid-template-columns: 1fr 1fr;">
    <div v-for="e in list" :key="e.id" class="card">
      <div class="card-head">
        <span style="display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 5px; background: var(--paper-3); color: var(--ink-3);"><Icon name="database" :size="12" /></span>
        <span style="font-weight: 500; flex: 1;">{{ e.name }}</span>
        <Pill :state="e.enabled ? 'ok' : 'standby'" :label="e.enabled ? 'enabled' : 'disabled'" />
        <Pill v-if="e.hasProxy" cls="violet" label="proxy" />
        <div class="actions">
          <button class="btn ghost sm" :disabled="testMut.isPending.value" @click="testMut.mutate(e.id)">
            <span v-if="testMut.isPending.value" class="spinner" />
            <Icon v-else name="zap" :size="11" /><span>Тест</span>
          </button>
          <Switch :model-value="e.enabled" @update:model-value="(v) => toggleMut.mutate({ id: e.id, enabled: v })" />
        </div>
      </div>
      <div class="card-body">
        <KeyValue :items="endpointKv(e)" />
        <div style="display: flex; justify-content: flex-end; gap: 6px; margin-top: 12px;">
          <button class="btn ghost sm" @click="openEdit(e)"><Icon name="edit" :size="11" /><span>Редактировать</span></button>
          <button class="btn danger sm" @click="deleteFor = e"><Icon name="trash" :size="11" /><span>Удалить</span></button>
        </div>
      </div>
    </div>
  </div>

  <EndpointForm
    :open="formOpen"
    :endpoint="editing"
    @close="formOpen = false"
    @saved="() => { formOpen = false; qc.invalidateQueries({ queryKey: ['endpoints'] }); }"
  />
  <ConfirmDialog
    :open="!!deleteFor"
    title="Удалить endpoint?"
    :description="deleteFor ? `Endpoint «${deleteFor.name}» перестанет работать. Агенты упадут на fallback или ошибку.` : ''"
    confirm-label="Удалить"
    destructive
    :loading="delMut.isPending.value"
    @close="deleteFor = null"
    @confirm="deleteFor && delMut.mutate(deleteFor.id)"
  />
</template>
