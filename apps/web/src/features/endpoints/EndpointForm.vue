<script setup lang="ts">
import { ref, watch } from 'vue';
import { useMutation } from '@tanstack/vue-query';
import Modal from '../../components/Modal.vue';
import Field from '../../components/Field.vue';
import TextInput from '../../components/TextInput.vue';
import SelectInput from '../../components/SelectInput.vue';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import type { LLMEndpoint } from './types';

const props = defineProps<{ open: boolean; endpoint: LLMEndpoint | null }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void }>();

const name = ref('');
const provider = ref<'yandex' | 'openrouter' | 'openai_compat'>('yandex');
const baseUrl = ref('');
const apiKey = ref('');
const folderId = ref('');
const iamToken = ref('');
const rateLimit = ref('');

function defaultBaseUrl(p: typeof provider.value): string {
  if (p === 'yandex') return 'https://llm.api.cloud.yandex.net';
  if (p === 'openrouter') return 'https://openrouter.ai/api/v1';
  return 'http://localhost:11434/v1';
}

watch(
  [() => props.open, () => props.endpoint],
  ([open, e]) => {
    if (!open) return;
    if (e) {
      name.value = e.name;
      provider.value = e.provider;
      baseUrl.value = e.baseUrl;
      apiKey.value = '';
      folderId.value = '';
      iamToken.value = '';
      rateLimit.value = e.rateLimitRpm ? String(e.rateLimitRpm) : '';
    } else {
      name.value = '';
      provider.value = 'yandex';
      baseUrl.value = defaultBaseUrl('yandex');
      apiKey.value = '';
      folderId.value = '';
      iamToken.value = '';
      rateLimit.value = '';
    }
  },
  { immediate: true },
);

watch(provider, (p) => {
  if (!props.endpoint) baseUrl.value = defaultBaseUrl(p);
});

const mut = useMutation({
  mutationFn: () => {
    const body: Record<string, unknown> = {
      name: name.value,
      provider: provider.value,
      baseUrl: baseUrl.value,
    };
    if (apiKey.value) body.apiKey = apiKey.value;
    if (folderId.value) body.folderId = folderId.value;
    if (iamToken.value) body.iamToken = iamToken.value;
    if (rateLimit.value) body.rateLimitRpm = Number(rateLimit.value);
    if (props.endpoint) return api.patch<LLMEndpoint>(`/endpoints/${props.endpoint.id}`, body);
    return api.post<LLMEndpoint>('/endpoints', body);
  },
  onSuccess: () => {
    toast.success(props.endpoint ? 'Endpoint обновлён' : 'Endpoint создан');
    emit('saved');
  },
  onError: (e: Error) => toast.error('Не удалось сохранить', e.message),
});
</script>

<template>
  <Modal
    :open="props.open"
    :title="endpoint ? 'Редактировать endpoint' : 'Новый LLM endpoint'"
    description="Ключи и токены шифруются перед записью в БД."
    size="lg"
    @close="emit('close')"
  >
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
      <Field label="Имя"><TextInput v-model="name" placeholder="yandex-prod / openrouter-default" /></Field>
      <Field label="Провайдер">
        <SelectInput
          v-model="provider as string"
          :options="[
            { value: 'yandex', label: 'Yandex Foundation Models' },
            { value: 'openrouter', label: 'OpenRouter' },
            { value: 'openai_compat', label: 'OpenAI-compatible (self-hosted)' },
          ]"
        />
      </Field>
      <Field label="Base URL" style="grid-column: 1 / -1;">
        <TextInput v-model="baseUrl" placeholder="https://..." />
      </Field>
      <Field label="API Key">
        <TextInput v-model="apiKey" type="password" :placeholder="endpoint ? '•••• оставьте пустым, чтобы не менять' : 'API key'" />
      </Field>
      <Field v-if="provider === 'yandex'" label="Folder ID">
        <TextInput v-model="folderId" placeholder="b1g..." />
      </Field>
      <Field v-if="provider === 'yandex'" label="IAM token (опционально)" help="Если не указан — будет использован API key." style="grid-column: 1 / -1;">
        <TextInput v-model="iamToken" type="password" />
      </Field>
      <Field label="Rate limit (RPM)">
        <TextInput v-model="rateLimit" type="number" placeholder="например 60" />
      </Field>
    </div>
    <template #footer>
      <button class="btn" :disabled="mut.isPending.value" @click="emit('close')">Отмена</button>
      <button class="btn primary" :disabled="mut.isPending.value || !name || !baseUrl" @click="mut.mutate()">
        <span v-if="mut.isPending.value" class="spinner" />
        <span>Сохранить</span>
      </button>
    </template>
  </Modal>
</template>
