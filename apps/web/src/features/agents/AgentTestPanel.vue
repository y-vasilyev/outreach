<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useMutation } from '@tanstack/vue-query';
import Field from '../../components/Field.vue';
import SelectInput from '../../components/SelectInput.vue';
import TextareaInput from '../../components/TextareaInput.vue';
import Pill from '../../components/Pill.vue';
import Icon from '../../components/Icon.vue';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { formatMoney, formatNumber } from '../../lib/format';
import { fixturesFor } from './fixtures';
import type { AgentTestResp } from './types';

const props = defineProps<{ agentId: string; agentName: string }>();

const fixtures = computed(() => fixturesFor(props.agentName));
const fixtureKey = ref<string>(fixtures.value[0]?.key ?? 'custom');
const inputJson = ref<string>(JSON.stringify(fixtures.value[0]?.input ?? {}, null, 2));
const error = ref<string | null>(null);
const result = ref<AgentTestResp | null>(null);

watch(fixtureKey, (k) => {
  const f = fixtures.value.find((x) => x.key === k);
  if (f) inputJson.value = JSON.stringify(f.input, null, 2);
});

watch(
  () => props.agentName,
  () => {
    fixtureKey.value = fixtures.value[0]?.key ?? 'custom';
    inputJson.value = JSON.stringify(fixtures.value[0]?.input ?? {}, null, 2);
    result.value = null;
  },
);

const mut = useMutation({
  mutationFn: () => {
    let payload: unknown;
    try {
      payload = JSON.parse(inputJson.value || '{}');
    } catch (e) {
      error.value = (e as Error).message;
      throw e;
    }
    error.value = null;
    return api.post<AgentTestResp>(`/agents/${props.agentId}/test`, { input: payload, dryRun: true });
  },
  onSuccess: (r) => {
    result.value = r;
    if (r.status === 'failed') toast.error('Запуск упал', r.error);
  },
  onError: (e: Error) => toast.error('Ошибка теста', e.message),
});
</script>

<template>
  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
    <div class="card">
      <div class="card-head">
        <Icon name="play" :size="12" /><span>Input</span>
        <div class="actions" style="width: 200px;">
          <SelectInput
            v-model="fixtureKey"
            :options="[
              ...fixtures.map((f) => ({ value: f.key, label: f.label })),
              { value: 'custom', label: 'custom' },
            ]"
          />
        </div>
      </div>
      <div class="card-body">
        <Field :error="error">
          <TextareaInput
            v-model="inputJson"
            :rows="18"
            mono
            @update:model-value="fixtureKey = 'custom'"
          />
        </Field>
        <div style="display: flex; justify-content: flex-end; margin-top: 10px;">
          <button class="btn primary" :disabled="mut.isPending.value" @click="mut.mutate()">
            <span v-if="mut.isPending.value" class="spinner" />
            <Icon v-else name="play" :size="11" />
            <span>Запустить (dry-run)</span>
          </button>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><Icon name="bot" :size="12" /><span>Output</span></div>
      <div class="card-body">
        <template v-if="result">
          <div style="display: flex; flex-wrap: wrap; gap: 6px; align-items: center;">
            <Pill :state="result.status === 'ok' ? 'ok' : result.status === 'fallback' ? 'paused' : 'failed'" :label="result.status" />
            <Pill v-if="result.tokensIn != null" state="ghost" :label="`tokens ${formatNumber(result.tokensIn)}/${formatNumber(result.tokensOut ?? 0)}`" />
            <Pill v-if="result.latencyMs != null" state="ghost" :label="`${result.latencyMs} мс`" />
            <Pill v-if="result.costUsd != null" state="ghost" :label="formatMoney(result.costUsd)" />
          </div>
          <pre class="mono" style="margin: 12px 0 0; padding: 12px; background: var(--ink); color: var(--paper); border-radius: var(--r-sm); max-height: 420px; overflow: auto; font-size: 12px;">{{ JSON.stringify(result.output, null, 2) }}</pre>
          <div v-if="result.error" class="field-error" style="margin-top: 8px;">{{ result.error }}</div>
        </template>
        <div v-else class="placeholder" style="min-height: 180px;">Запустите тест, чтобы увидеть результат</div>
      </div>
    </div>
  </div>
</template>
