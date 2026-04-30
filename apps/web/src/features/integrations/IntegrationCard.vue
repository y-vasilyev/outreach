<script setup lang="ts">
import { ref, watch } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import Field from '../../components/Field.vue';
import TextInput from '../../components/TextInput.vue';
import Switch from '../../components/Switch.vue';
import Pill from '../../components/Pill.vue';
import Icon from '../../components/Icon.vue';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { formatDateTime } from '../../lib/format';

interface Integration {
  kind: string;
  enabled: boolean;
  status: 'ok' | 'error' | 'unknown' | string;
  lastCheckAt: string | null;
}

const props = defineProps<{ kind: string; title: string; description: string }>();

const qc = useQueryClient();
const apiKey = ref('');
const baseUrl = ref('https://api.scrapecreators.com');
const enabled = ref(false);

const { data } = useQuery({
  queryKey: ['integration', () => props.kind],
  queryFn: () => api.get<Integration>(`/integrations/${props.kind}`),
});

watch(
  () => data.value,
  (d) => {
    if (!d) return;
    enabled.value = d.enabled;
  },
);

const saveMut = useMutation({
  mutationFn: () => api.put<Integration>(`/integrations/${props.kind}`, {
    apiKey: apiKey.value,
    baseUrl: baseUrl.value,
    enabled: enabled.value,
  }),
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: ['integration', props.kind] });
    toast.success('Интеграция сохранена');
  },
  onError: (e: Error) => toast.error('Не удалось сохранить', e.message),
});

const testMut = useMutation({
  mutationFn: () => api.post<{ ok: boolean; latencyMs?: number; error?: string }>(`/integrations/${props.kind}/test`, {}),
  onSuccess: (r) => {
    qc.invalidateQueries({ queryKey: ['integration', props.kind] });
    if (r.ok) toast.success('Коннект OK', r.latencyMs ? `${r.latencyMs} мс` : undefined);
    else toast.error('Коннект не прошёл', r.error);
  },
  onError: (e: Error) => toast.error('Ошибка проверки', e.message),
});
</script>

<template>
  <div class="card">
    <div class="card-head">
      <span style="display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 5px; background: var(--paper-3); color: var(--ink-3);"><Icon name="link" :size="12" /></span>
      <span style="font-weight: 500; flex: 1;">{{ title }}</span>
      <Pill
        :state="data?.status === 'ok' ? 'ok' : data?.status === 'error' ? 'failed' : 'unknown'"
        :label="data?.status ?? 'unknown'"
      />
      <div class="actions">
        <Switch v-model="enabled" />
      </div>
    </div>
    <div class="card-body">
      <p class="muted" style="font-size: 12.5px; margin: 0 0 10px;">{{ description }}</p>
      <p v-if="data?.lastCheckAt" class="muted-2" style="font-size: 11px; margin: 0 0 12px;">
        Последняя проверка: {{ formatDateTime(data.lastCheckAt) }}
      </p>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
        <Field label="API ключ"><TextInput v-model="apiKey" type="password" placeholder="sk-..." /></Field>
        <Field label="Base URL"><TextInput v-model="baseUrl" placeholder="https://api.scrapecreators.com" /></Field>
      </div>
      <div style="display: flex; gap: 6px; justify-content: flex-end; margin-top: 12px;">
        <button class="btn" :disabled="testMut.isPending.value || !apiKey" @click="testMut.mutate()">
          <span v-if="testMut.isPending.value" class="spinner" />
          <Icon v-else name="zap" :size="12" /><span>Проверить коннект</span>
        </button>
        <button class="btn primary" :disabled="saveMut.isPending.value" @click="saveMut.mutate()">
          <span v-if="saveMut.isPending.value" class="spinner" />
          <span>Сохранить</span>
        </button>
      </div>
    </div>
  </div>
</template>
