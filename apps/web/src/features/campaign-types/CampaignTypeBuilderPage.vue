<script setup lang="ts">
import { computed, ref } from 'vue';
import { useMutation } from '@tanstack/vue-query';
import { useRouter } from 'vue-router';
import PageHead from '../../components/PageHead.vue';
import Icon from '../../components/Icon.vue';
import Field from '../../components/Field.vue';
import TextInput from '../../components/TextInput.vue';
import TextareaInput from '../../components/TextareaInput.vue';
import TagInput from '../../components/TagInput.vue';
import Pill from '../../components/Pill.vue';
import EmptyState from '../../components/EmptyState.vue';
import FeatureOff from '../../components/FeatureOff.vue';
import { api } from '../../lib/api';
import { isFeatureOff } from '../../lib/featureGate';
import { toast } from '../../lib/toast';
import { formatMoney, formatNumber } from '../../lib/format';
import type { CampaignType, CampaignTypeDraft, DraftAgentConfig, DraftAgentTestResult } from './types';

const router = useRouter();

// ─── Build input ───
const goalDescription = ref('');
const examples = ref<string[]>([]);

const draft = ref<CampaignTypeDraft | null>(null);
const featureOff = ref(false);

const canBuild = computed(() => goalDescription.value.trim().length > 0);

const buildMut = useMutation({
  mutationFn: () =>
    api.post<CampaignTypeDraft>('/campaign-type-builder/draft', {
      goal_description: goalDescription.value.trim(),
      ...(examples.value.length ? { examples: examples.value } : {}),
    }),
  onSuccess: (d) => {
    draft.value = d;
    toast.success('Черновик собран', `Ролей: ${d.agents.length}`);
  },
  onError: (e) => {
    if (isFeatureOff(e)) {
      featureOff.value = true;
      return;
    }
    toast.error('Не удалось собрать черновик', (e as Error).message);
  },
});

const saveMut = useMutation({
  mutationFn: () => api.post<CampaignType>('/campaign-type-builder/save', { draft: draft.value }),
  onSuccess: (t) => {
    toast.success('Тип кампании сохранён', t.name);
    router.push('/campaigns');
  },
  onError: (e) => toast.error('Не удалось сохранить', (e as Error).message),
});

// Light edits to the draft (key/name/description). Mutations are applied to
// the in-memory draft and persisted on save.
function setKey(v: string): void {
  if (draft.value) draft.value.key = v;
}
function setName(v: string): void {
  if (draft.value) draft.value.name = v;
}
function setDescription(v: string): void {
  if (draft.value) draft.value.description = v;
}
function setSystemPrompt(i: number, v: string): void {
  const a = draft.value?.agents[i];
  if (a) a.systemPrompt = v;
}
function setUserPrompt(i: number, v: string): void {
  const a = draft.value?.agents[i];
  if (a) a.userPromptTemplate = v;
}

const agentRows = computed<{ agent: DraftAgentConfig; index: number; result: DraftAgentTestResult | null }[]>(
  () =>
    (draft.value?.agents ?? []).map((agent, index) => ({
      agent,
      index,
      result: draft.value?.testResults.find((r) => r.role === agent.role && r.name === agent.name) ?? null,
    })),
);

function prettyJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

const goalSchemaJson = computed(() => prettyJson(draft.value?.goalSchema ?? {}));
const safetyJson = computed(() => prettyJson(draft.value?.safetyProfile ?? {}));

const canSave = computed(() => {
  const d = draft.value;
  if (!d) return false;
  return /^[a-z][a-z0-9_]*$/.test(d.key) && d.name.trim().length > 0;
});
const keyValid = computed(() => !draft.value || /^[a-z][a-z0-9_]*$/.test(draft.value.key));
</script>

<template>
  <PageHead title="Конструктор типов кампаний" sub="Опишите цель на естественном языке — агент соберёт черновик типа кампании">
    <template #actions>
      <button class="btn" @click="router.push('/campaigns')"><Icon name="arrow_left" :size="12" /><span>К кампаниям</span></button>
    </template>
  </PageHead>

  <FeatureOff v-if="featureOff" flag="ENABLE_CAMPAIGN_TYPES" />

  <template v-else>
    <!-- Build input -->
    <div class="card">
      <div class="card-head"><Icon name="sparkle" :size="12" /><span>Цель</span></div>
      <div class="card-body">
        <Field label="Опишите цель кампании" help='Например: "Собирать прайсы и охваты у блогеров от лица рекламного агентства".'>
          <TextareaInput v-model="goalDescription" :rows="3" placeholder="Что должна делать кампания и какой результат нужен" />
        </Field>
        <Field label="Примеры (необязательно)" help="Примеры желаемого поведения / реплик. Enter — добавить.">
          <TagInput v-model="examples" placeholder="Пример и Enter" />
        </Field>
        <button class="btn primary" :disabled="buildMut.isPending.value || !canBuild" @click="buildMut.mutate()">
          <span v-if="buildMut.isPending.value" class="spinner" />
          <Icon v-else name="zap" :size="12" />
          <span>Собрать черновик</span>
        </button>
      </div>
    </div>

    <EmptyState
      v-if="!draft && !buildMut.isPending.value"
      title="Черновик ещё не собран"
      description="Опишите цель и нажмите «Собрать черновик» — появятся goal-схема, профиль безопасности и агенты с dry-run результатами."
      icon="bot"
      style="margin-top: 16px;"
    />

    <template v-if="draft">
      <!-- Unavailable tier warnings -->
      <div
        v-if="draft.unavailableTiers.length"
        class="card"
        style="margin-top: 16px; border-color: var(--warn);"
      >
        <div class="card-head"><Icon name="warn" :size="12" /><span>Нет endpoint для тиров</span></div>
        <div class="card-body">
          <p class="muted" style="margin: 0;">
            Для тиров <strong>{{ draft.unavailableTiers.join(', ') }}</strong> не настроен ни один endpoint.
            Агенты этих тиров не были прогнаны (dry-run пропущен) и не получат рабочую модель до настройки endpoint.
          </p>
        </div>
      </div>

      <!-- Editable header fields -->
      <div class="card" style="margin-top: 16px;">
        <div class="card-head"><Icon name="flag" :size="12" /><span>Тип кампании</span></div>
        <div class="card-body" style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <Field label="Ключ (snake_case)" :error="keyValid ? null : 'Ключ должен быть в snake_case: [a-z][a-z0-9_]*'">
            <TextInput :model-value="draft.key" :error="!keyValid" mono @update:model-value="setKey" />
          </Field>
          <Field label="Название">
            <TextInput :model-value="draft.name" @update:model-value="setName" />
          </Field>
          <Field label="Описание" style="grid-column: 1 / -1;">
            <TextareaInput :model-value="draft.description" :rows="2" @update:model-value="setDescription" />
          </Field>
        </div>
      </div>

      <!-- Goal schema + safety profile -->
      <div class="card" style="margin-top: 12px;">
        <div class="card-head"><Icon name="list" :size="12" /><span>Goal-схема</span></div>
        <div class="card-body">
          <pre class="mono" style="margin: 0; font-size: 12px; white-space: pre-wrap;">{{ goalSchemaJson }}</pre>
        </div>
      </div>
      <div class="card" style="margin-top: 12px;">
        <div class="card-head"><Icon name="shield" :size="12" /><span>Профиль безопасности</span></div>
        <div class="card-body">
          <pre class="mono" style="margin: 0; font-size: 12px; white-space: pre-wrap;">{{ safetyJson }}</pre>
        </div>
      </div>

      <!-- Per-role agents + dry-run results -->
      <div class="card" style="margin-top: 12px;">
        <div class="card-head"><Icon name="bot" :size="12" /><span>Агенты ({{ draft.agents.length }})</span></div>
        <div class="card-body" style="display: flex; flex-direction: column; gap: 12px;">
          <div v-for="row in agentRows" :key="row.agent.role" class="card" style="margin: 0;">
            <div class="card-head" style="background: var(--paper-2);">
              <span class="mono muted-2">{{ row.agent.role }}</span>
              <span style="font-weight: 500; flex: 1;">{{ row.agent.name }}</span>
              <Pill :cls="row.agent.tierAvailable ? 'accent' : 'warn'" :dot="false" :label="row.agent.tier" />
              <Pill v-if="!row.agent.tierAvailable" cls="bad" :dot="false" label="нет endpoint" />
              <span v-else class="muted-2" style="font-size: 11px;">{{ row.agent.provider }} · {{ row.agent.model }}</span>
            </div>
            <div class="card-body">
              <Field label="System prompt">
                <TextareaInput :model-value="row.agent.systemPrompt" :rows="3" mono @update:model-value="(v) => setSystemPrompt(row.index, v)" />
              </Field>
              <Field label="User prompt template">
                <TextareaInput :model-value="row.agent.userPromptTemplate" :rows="3" mono @update:model-value="(v) => setUserPrompt(row.index, v)" />
              </Field>

              <!-- Dry-run result -->
              <div
                v-if="row.result"
                style="margin-top: 8px; border-top: 1px solid var(--line); padding-top: 8px;"
              >
                <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 6px;">
                  <span class="muted-2" style="font-size: 11px; text-transform: uppercase;">dry-run</span>
                  <Pill v-if="!row.result.ran" cls="warn" :dot="false" :label="row.result.skippedReason ?? 'пропущен'" />
                  <Pill v-else-if="row.result.error" cls="bad" :dot="false" label="ошибка" />
                  <Pill v-else cls="ok" :dot="false" label="ok" />
                  <template v-if="row.result.ran && !row.result.error">
                    <span class="muted-2" style="font-size: 11px;">tokens in/out: <span class="mono">{{ formatNumber(row.result.tokensIn) }}/{{ formatNumber(row.result.tokensOut) }}</span></span>
                    <span class="muted-2" style="font-size: 11px;">cost: <span class="mono">{{ formatMoney(row.result.costUsd) }}</span></span>
                    <span class="muted-2" style="font-size: 11px;">latency: <span class="mono">{{ formatNumber(row.result.latencyMs) }} ms</span></span>
                  </template>
                </div>
                <p v-if="row.result.error" class="muted" style="font-size: 12px; color: var(--bad); margin: 0;">{{ row.result.error }}</p>
                <pre
                  v-else-if="row.result.ran"
                  class="mono"
                  style="margin: 0; font-size: 11.5px; white-space: pre-wrap; max-height: 220px; overflow: auto; background: var(--paper-2); padding: 8px; border-radius: var(--r-sm);"
                >{{ prettyJson(row.result.output) }}</pre>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Save -->
      <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; position: sticky; bottom: 16px;">
        <button class="btn primary" :disabled="saveMut.isPending.value || !canSave" @click="saveMut.mutate()">
          <span v-if="saveMut.isPending.value" class="spinner" />
          <Icon v-else name="check" :size="12" />
          <span>Сохранить тип</span>
        </button>
      </div>
    </template>
  </template>
</template>
