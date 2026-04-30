<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import PageHead from '../../components/PageHead.vue';
import Tabs from '../../components/Tabs.vue';
import Field from '../../components/Field.vue';
import SelectInput from '../../components/SelectInput.vue';
import TextareaInput from '../../components/TextareaInput.vue';
import Switch from '../../components/Switch.vue';
import ModelCombobox from '../../components/ModelCombobox.vue';
import Pill from '../../components/Pill.vue';
import Spinner from '../../components/Spinner.vue';
import Icon from '../../components/Icon.vue';
import AgentTestPanel from './AgentTestPanel.vue';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { formatDateTime, formatMoney, formatNumber } from '../../lib/format';
import type { AgentConfig, AgentRunHistory } from './types';
import type { LLMEndpoint } from '../endpoints/types';

const route = useRoute();
const router = useRouter();
const qc = useQueryClient();

const id = computed(() => route.params.id as string);
const tab = ref<'config' | 'test' | 'history'>('config');

const { data: agent, isLoading } = useQuery({
  queryKey: ['agent', id],
  queryFn: () => api.get<AgentConfig>(`/agents/${id.value}`),
  enabled: computed(() => !!id.value),
});

const { data: endpoints } = useQuery({
  queryKey: ['endpoints'],
  queryFn: () => api.get<LLMEndpoint[]>('/endpoints'),
});

const endpointId = ref('');
const fallbackId = ref('');
const model = ref('');
const systemPrompt = ref('');
const userTemplate = ref('');
const enabled = ref(true);
const paramsJson = ref('{}');
const paramsError = ref<string | null>(null);

watch(
  () => agent.value,
  (a) => {
    if (!a) return;
    endpointId.value = a.endpointId ?? '';
    fallbackId.value = a.fallbackEndpointId ?? '';
    model.value = a.model;
    systemPrompt.value = a.systemPrompt;
    userTemplate.value = a.userPromptTemplate;
    enabled.value = a.enabled;
    paramsJson.value = JSON.stringify(a.params ?? {}, null, 2);
  },
  { immediate: true },
);

const epOptions = computed(() => [
  { value: '', label: '— не задан —' },
  ...((endpoints.value ?? []).map((e) => ({ value: e.id, label: `${e.name} (${e.provider})` }))),
]);

const fallbackOptions = computed(() => [
  { value: '', label: '— нет —' },
  ...((endpoints.value ?? []).map((e) => ({ value: e.id, label: `${e.name} (${e.provider})` }))),
]);

const tabsList = [
  { id: 'config', label: 'Config' },
  { id: 'test', label: 'Test' },
  { id: 'history', label: 'История' },
];

const usedVars = computed(() => extractVars(`${systemPrompt.value}\n${userTemplate.value}`));
const declared = computed(() => agent.value?.variables ?? []);
const missing = computed(() => declared.value.filter((v) => !usedVars.value.has(v)));

const saveMut = useMutation({
  mutationFn: () => {
    let params: unknown = {};
    try {
      params = JSON.parse(paramsJson.value || '{}');
      paramsError.value = null;
    } catch (e) {
      paramsError.value = (e as Error).message;
      throw e;
    }
    return api.patch<AgentConfig>(`/agents/${id.value}`, {
      endpointId: endpointId.value || null,
      fallbackEndpointId: fallbackId.value || null,
      model: model.value,
      systemPrompt: systemPrompt.value,
      userPromptTemplate: userTemplate.value,
      enabled: enabled.value,
      params,
    });
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: ['agent', id.value] });
    qc.invalidateQueries({ queryKey: ['agents'] });
    toast.success('Конфиг сохранён', `Версия v${(agent.value?.version ?? 0) + 1}`);
  },
  onError: (e: Error) => toast.error('Не удалось сохранить', e.message),
});

const { data: history, isLoading: historyLoading } = useQuery({
  queryKey: ['agent-history', id],
  queryFn: () => api.get<AgentRunHistory[]>(`/agents/${id.value}/history?limit=50`),
  enabled: computed(() => tab.value === 'history' && !!id.value),
});

function extractVars(s: string): Set<string> {
  const set = new Set<string>();
  const re = /\{\{([a-zA-Z_][\w]*)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) if (m[1]) set.add(m[1]);
  return set;
}

function fmtVar(v: string): string {
  return `{{${v}}}`;
}

function reset(): void {
  if (!agent.value) return;
  endpointId.value = agent.value.endpointId ?? '';
  fallbackId.value = agent.value.fallbackEndpointId ?? '';
  model.value = agent.value.model;
  systemPrompt.value = agent.value.systemPrompt;
  userTemplate.value = agent.value.userPromptTemplate;
  enabled.value = agent.value.enabled;
  paramsJson.value = JSON.stringify(agent.value.params ?? {}, null, 2);
  paramsError.value = null;
}
</script>

<template>
  <PageHead :title="agent?.name ?? 'Agent'" :sub="agent?.description ?? agent?.role ?? 'Карточка агента'">
    <template #actions>
      <button class="btn" @click="router.push('/agents')"><Icon name="arrow_left" :size="12" /><span>Все агенты</span></button>
      <button class="btn"><Icon name="copy" :size="12" /><span>Дублировать</span></button>
      <Pill v-if="agent" cls="accent" :label="`v${agent.version}`" :dot="false" />
    </template>
  </PageHead>

  <div v-if="isLoading || !agent" class="center"><Spinner /></div>
  <template v-else>
    <Tabs :tabs="tabsList" :active="tab" @change="(id) => (tab = id as any)" />

    <div v-if="tab === 'config'" class="cards" style="grid-template-columns: 1fr;">
      <div class="card">
        <div class="card-head"><Icon name="sliders" :size="12" /><span>Endpoint и модель</span></div>
        <div class="card-body">
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <Field label="Endpoint">
              <SelectInput v-model="endpointId" :options="epOptions" />
            </Field>
            <Field label="Fallback endpoint">
              <SelectInput v-model="fallbackId" :options="fallbackOptions" />
            </Field>
            <ModelCombobox
              :endpoint-id="endpointId || null"
              v-model="model"
              label="Модель"
              help="Список моделей подгружается из выбранного endpoint. Можно ввести свой id."
            />
            <Field label="Включён">
              <div style="display: flex; align-items: center; gap: 10px; padding: 4px 0;">
                <Switch v-model="enabled" />
                <span class="muted" style="font-size: 11.5px;">Если выключен — агент возвращает fallback или роняет пайплайн.</span>
              </div>
            </Field>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <Icon name="edit" :size="12" /><span>System prompt</span>
          <div class="actions" v-if="declared.length">
            <span class="muted-2" style="font-size: 10.5px;">Vars:</span>
            <code
              v-for="v in declared"
              :key="v"
              class="mono"
              :style="{
                padding: '1px 5px',
                fontSize: '10.5px',
                borderRadius: '3px',
                background: usedVars.has(v) ? 'var(--ok-bg)' : 'var(--bad-bg)',
                color: usedVars.has(v) ? 'var(--ok)' : 'var(--bad)',
                border: '1px solid',
                borderColor: usedVars.has(v) ? 'var(--ok-line)' : 'var(--bad-line)',
              }"
            >{{ fmtVar(v) }}</code>
            <span v-if="missing.length" class="field-error" style="font-size: 10.5px;">не использованы: {{ missing.length }}</span>
          </div>
        </div>
        <div class="card-body">
          <TextareaInput v-model="systemPrompt" :rows="10" mono />
        </div>
      </div>

      <div class="card">
        <div class="card-head"><Icon name="edit" :size="12" /><span>User prompt template</span></div>
        <div class="card-body">
          <TextareaInput v-model="userTemplate" :rows="8" mono />
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <Icon name="sliders" :size="12" /><span>Params (JSON)</span>
          <div class="actions"><span class="muted-2" style="font-size: 10.5px;">temperature, max_tokens, top_p, json_schema…</span></div>
        </div>
        <div class="card-body">
          <Field :error="paramsError">
            <TextareaInput v-model="paramsJson" :rows="10" mono :error="!!paramsError" />
          </Field>
        </div>
      </div>

      <div style="display: flex; align-items: center; justify-content: space-between; padding: 0 22px 22px;">
        <div class="muted-2" style="font-size: 11px;">Обновлён: {{ formatDateTime(agent.updatedAt) }}</div>
        <div style="display: flex; gap: 6px;">
          <button class="btn" @click="reset"><Icon name="refresh" :size="12" /><span>Сбросить</span></button>
          <button class="btn primary" :disabled="saveMut.isPending.value" @click="saveMut.mutate()">
            <span v-if="saveMut.isPending.value" class="spinner" />
            <Icon v-else name="check" :size="12" /><span>Сохранить новую версию</span>
          </button>
        </div>
      </div>
    </div>

    <div v-else-if="tab === 'test'" style="padding: 14px 22px 22px;">
      <AgentTestPanel :agent-id="agent.id" :agent-name="agent.name" />
    </div>

    <div v-else-if="tab === 'history'" style="padding: 14px 22px 22px;">
      <div v-if="historyLoading" class="center"><Spinner /></div>
      <div v-else-if="!history || history.length === 0" class="placeholder" style="min-height: 120px;">
        Пока нет запусков агента {{ agent.name }}.
      </div>
      <div v-else class="card" style="border-radius: var(--r-md);">
        <div class="table-wrap">
          <table class="tbl">
            <thead>
              <tr>
                <th>Когда</th>
                <th>Статус</th>
                <th>Модель</th>
                <th style="text-align: right;">Tokens in/out</th>
                <th style="text-align: right;">Latency</th>
                <th style="text-align: right;">Cost</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="h in history" :key="h.id">
                <td>{{ formatDateTime(h.createdAt) }}</td>
                <td><Pill :state="h.status === 'ok' ? 'ok' : h.status === 'fallback' ? 'paused' : 'failed'" :label="h.status" /></td>
                <td class="mono muted-2" style="font-size: 11px;">{{ h.model ?? '—' }}</td>
                <td class="mono" style="text-align: right;">{{ formatNumber(h.tokensIn) }} / {{ formatNumber(h.tokensOut) }}</td>
                <td class="mono" style="text-align: right;">{{ h.latencyMs }} мс</td>
                <td class="mono" style="text-align: right;">{{ formatMoney(h.costUsd) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </template>
</template>
