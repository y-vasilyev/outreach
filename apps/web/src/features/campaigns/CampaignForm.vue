<script setup lang="ts">
import { ref, watch } from 'vue';
import { useMutation } from '@tanstack/vue-query';
import Modal from '../../components/Modal.vue';
import Field from '../../components/Field.vue';
import TextInput from '../../components/TextInput.vue';
import TextareaInput from '../../components/TextareaInput.vue';
import SelectInput from '../../components/SelectInput.vue';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import type { Campaign } from './types';

const props = defineProps<{ open: boolean; campaign: Campaign | null }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void }>();

const DEFAULT_FILTER = JSON.stringify({ platforms: ['telegram'], roleGuess: ['ad_manager', 'owner'] }, null, 2);
const DEFAULT_OVERRIDES = '{}';
const DEFAULT_SCHEDULE = JSON.stringify({
  tz: 'Europe/Moscow',
  workHours: { start: '10:00', end: '20:00' },
  days: [1, 2, 3, 4, 5],
  maxPerDayPerAccount: 25,
}, null, 2);

const name = ref('');
const goal = ref('');
const valueProp = ref('');
const mode = ref<'auto' | 'assisted' | 'manual'>('assisted');
const filterJson = ref(DEFAULT_FILTER);
const overridesJson = ref(DEFAULT_OVERRIDES);
const scheduleJson = ref(DEFAULT_SCHEDULE);
const error = ref<string | null>(null);

watch(
  [() => props.open, () => props.campaign],
  ([open, c]) => {
    if (!open) return;
    if (c) {
      name.value = c.name;
      goal.value = c.goalText;
      valueProp.value = c.valueProp;
      mode.value = c.defaultMode;
      filterJson.value = JSON.stringify(c.targetFilter ?? {}, null, 2);
      overridesJson.value = JSON.stringify(c.agentOverrides ?? {}, null, 2);
      scheduleJson.value = JSON.stringify(c.schedule ?? {}, null, 2);
    } else {
      name.value = '';
      goal.value = '';
      valueProp.value = '';
      mode.value = 'assisted';
      filterJson.value = DEFAULT_FILTER;
      overridesJson.value = DEFAULT_OVERRIDES;
      scheduleJson.value = DEFAULT_SCHEDULE;
    }
    error.value = null;
  },
  { immediate: true },
);

const mut = useMutation({
  mutationFn: () => {
    let targetFilter: unknown = {};
    let agentOverrides: unknown = {};
    let schedule: unknown = {};
    try {
      targetFilter = JSON.parse(filterJson.value || '{}');
      agentOverrides = JSON.parse(overridesJson.value || '{}');
      schedule = JSON.parse(scheduleJson.value || '{}');
      error.value = null;
    } catch (e) {
      error.value = (e as Error).message;
      throw e;
    }
    const body = {
      name: name.value,
      goalText: goal.value,
      valueProp: valueProp.value,
      defaultMode: mode.value,
      targetFilter,
      agentOverrides,
      schedule,
    };
    if (props.campaign) return api.patch<Campaign>(`/campaigns/${props.campaign.id}`, body);
    return api.post<Campaign>('/campaigns', body);
  },
  onSuccess: () => {
    toast.success(props.campaign ? 'Кампания обновлена' : 'Кампания создана');
    emit('saved');
  },
  onError: (e: Error) => toast.error('Не удалось сохранить', e.message),
});
</script>

<template>
  <Modal
    :open="props.open"
    size="xl"
    :title="campaign ? 'Редактировать кампанию' : 'Новая кампания'"
    description="Цель — CustDev. SafetyFilter блокирует продажные формулировки автоматически."
    @close="emit('close')"
  >
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
      <Field label="Название"><TextInput v-model="name" placeholder="CustDev — B2B SaaS Q2" /></Field>
      <Field label="Default mode">
        <SelectInput
          v-model="mode as string"
          :options="[
            { value: 'auto', label: 'auto — ИИ отправляет сам (low-risk)' },
            { value: 'assisted', label: 'assisted — оператор подтверждает' },
            { value: 'manual', label: 'manual — оператор пишет сам' },
          ]"
        />
      </Field>
      <Field label="Цель / goalText" style="grid-column: 1 / -1;">
        <TextareaInput v-model="goal" :rows="3" placeholder="20 минут CustDev по продукту X" />
      </Field>
      <Field label="Value-prop (что получит респондент)" style="grid-column: 1 / -1;">
        <TextareaInput v-model="valueProp" :rows="2" placeholder="доступ к бете / $30 / итоговый отчёт" />
      </Field>
    </div>

    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-top: 14px;">
      <Field label="Target filter (JSON)" help="platforms, roleGuess, languages, topics, tags, minConfidence">
        <TextareaInput v-model="filterJson" :rows="10" mono />
      </Field>
      <Field label="Agent overrides (JSON)" help='{"reply_composer":{"params":{"temperature":0.4}}}'>
        <TextareaInput v-model="overridesJson" :rows="10" mono />
      </Field>
      <Field label="Schedule (JSON)" help="tz, workHours.start/.end, days, maxPerDayPerAccount">
        <TextareaInput v-model="scheduleJson" :rows="10" mono />
      </Field>
    </div>

    <div v-if="error" class="field-error" style="margin-top: 10px;">JSON: {{ error }}</div>

    <template #footer>
      <button class="btn" :disabled="mut.isPending.value" @click="emit('close')">Отмена</button>
      <button
        class="btn primary"
        :disabled="mut.isPending.value || !name || !goal || !valueProp"
        @click="mut.mutate()"
      >
        <span v-if="mut.isPending.value" class="spinner" />
        <span>Сохранить</span>
      </button>
    </template>
  </Modal>
</template>
