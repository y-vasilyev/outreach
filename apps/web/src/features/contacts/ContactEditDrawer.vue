<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import Drawer from '../../components/Drawer.vue';
import Field from '../../components/Field.vue';
import TextInput from '../../components/TextInput.vue';
import SelectInput from '../../components/SelectInput.vue';
import Pill from '../../components/Pill.vue';
import Tag from '../../components/Tag.vue';
import ConfBar from '../../components/ConfBar.vue';
import Icon from '../../components/Icon.vue';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { formatDateTime } from '../../lib/format';
import type { Contact, ContactRole, ContactType, ContactStatus } from './types';

const props = defineProps<{ contact: Contact | null }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'updated'): void }>();

const qc = useQueryClient();

const value = ref('');
const label = ref('');
const role = ref<ContactRole>('unknown');
const type = ref<ContactType>('other');
const status = ref<ContactStatus>('new');
const confidence = ref(0);

watch(
  () => props.contact,
  (c) => {
    if (!c) return;
    value.value = c.value;
    label.value = c.label ?? '';
    role.value = c.roleGuess;
    type.value = c.type;
    status.value = c.status;
    confidence.value = Number(c.confidence) || 0;
  },
  { immediate: true },
);

const ROLES = [
  { value: 'owner', label: 'owner' },
  { value: 'ad_manager', label: 'ad_manager' },
  { value: 'generic', label: 'generic' },
  { value: 'bot', label: 'bot' },
  { value: 'unknown', label: 'unknown' },
];

const TYPES = [
  { value: 'tg_username', label: 'tg_username' },
  { value: 'tg_link', label: 'tg_link' },
  { value: 'tg_phone', label: 'tg_phone' },
  { value: 'email', label: 'email' },
  { value: 'website', label: 'website' },
  { value: 'web_form', label: 'web_form' },
  { value: 'other', label: 'other' },
];

const STATUSES = [
  { value: 'new', label: 'new — ещё не вычитан оператором' },
  { value: 'qualified', label: 'qualified — годится в кампанию' },
  { value: 'disqualified', label: 'disqualified — отбраковать' },
  { value: 'contacted', label: 'contacted — opener отправлен' },
  { value: 'active', label: 'active — идёт диалог' },
  { value: 'finished', label: 'finished — закрыт' },
  { value: 'invalid', label: 'invalid — невалидный handle' },
  { value: 'blocked', label: 'blocked — забанил/заблокировал' },
];

const isManual = computed(() => props.contact?.extractedBy === 'manual');

const dirty = computed(() => {
  const c = props.contact;
  if (!c) return false;
  return (
    value.value !== c.value ||
    (label.value || null) !== (c.label ?? null) ||
    role.value !== c.roleGuess ||
    type.value !== c.type ||
    status.value !== c.status ||
    Math.abs(confidence.value - Number(c.confidence)) > 1e-6
  );
});

const saveMut = useMutation({
  mutationFn: () => {
    const id = props.contact!.id;
    return api.patch<Contact>(`/contacts/${id}`, {
      value: value.value,
      label: label.value || null,
      roleGuess: role.value,
      type: type.value,
      status: status.value,
      confidence: confidence.value,
    });
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: ['contacts'] });
    toast.success('Контакт обновлён', 'Помечен как manual override');
    emit('updated');
  },
  onError: (e: Error) => toast.error('Не удалось сохранить', e.message),
});

const reExtractMut = useMutation({
  mutationFn: () => api.post<{ ok: true; jobId: string }>(`/contacts/${props.contact!.id}/re-extract`, {}),
  onSuccess: () => {
    toast.info('LLM-extractor поставлен в очередь', 'Канал переобрабатывается');
    qc.invalidateQueries({ queryKey: ['contacts'] });
    qc.invalidateQueries({ queryKey: ['channels'] });
  },
  onError: (e: Error) => toast.error('Не удалось перезапустить', e.message),
});
</script>

<template>
  <Drawer :open="!!contact" :title="contact ? `Контакт: ${contact.value}` : ''" @close="emit('close')">
    <template v-if="contact" #head-actions>
      <Tag v-if="contact.channel?.platform" :platform="contact.channel.platform" />
      <Pill v-if="isManual" cls="violet" label="manual override" :dot="false" />
      <button
        class="btn sm"
        :disabled="reExtractMut.isPending.value"
        @click="reExtractMut.mutate()"
      >
        <span v-if="reExtractMut.isPending.value" class="spinner" />
        <Icon v-else name="sparkle" :size="11" />
        <span>Обновить через ИИ</span>
      </button>
    </template>

    <template v-if="contact">
      <div class="card">
        <div class="card-head"><Icon name="user" :size="12" /><span>Идентификация</span></div>
        <div class="card-body">
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <Field label="Тип"><SelectInput v-model="type as string" :options="TYPES" /></Field>
            <Field label="Роль"><SelectInput v-model="role as string" :options="ROLES" /></Field>
            <Field
              label="Статус"
              style="grid-column: 1 / -1;"
              help="Кампания берёт только qualified-контакты. Поднимите статус до qualified, если уверены, что хотите по нему писать."
            >
              <SelectInput v-model="status as string" :options="STATUSES" />
            </Field>
            <Field label="Value (handle / email / URL)" style="grid-column: 1 / -1;">
              <TextInput v-model="value" :mono="true" />
            </Field>
            <Field label="Заметка / label" style="grid-column: 1 / -1;" help="Свободная подпись, помогает оператору.">
              <TextInput v-model="label" />
            </Field>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top: 12px;">
        <div class="card-head"><Icon name="sparkle" :size="12" /><span>Уверенность</span></div>
        <div class="card-body">
          <div style="display: flex; gap: 12px; align-items: center;">
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              :value="confidence"
              @input="confidence = Number(($event.target as HTMLInputElement).value)"
              style="flex: 1;"
            />
            <span class="mono cell-strong" style="min-width: 48px; text-align: right;">{{ confidence.toFixed(2) }}</span>
            <ConfBar :value="confidence" />
          </div>
          <div class="muted-2" style="font-size: 11px; margin-top: 6px;">
            ≥ 0.40 — qualified · ≥ 0.70 — high · ≥ 0.85 — very high
          </div>
        </div>
      </div>

      <div class="card" style="margin-top: 12px;">
        <div class="card-head"><Icon name="info" :size="12" /><span>Метаданные</span></div>
        <div class="card-body">
          <dl class="kv">
            <dt>Provenance</dt>
            <dd>
              <span class="mono">{{ contact.extractedBy ?? 'regex' }}</span>
              <span v-if="isManual" class="muted-2"> · оператор поправил</span>
            </dd>
            <dt>Канал</dt>
            <dd>{{ contact.channel?.title || contact.channel?.handle || '—' }}</dd>
            <dt>Reachability</dt><dd><Pill :state="contact.reachability" /></dd>
            <dt>Статус</dt><dd><Pill :state="contact.status" /></dd>
            <dt>Создан</dt><dd>{{ formatDateTime(contact.createdAt) }}</dd>
            <dt>Обновлён</dt><dd>{{ formatDateTime(contact.updatedAt) }}</dd>
          </dl>
        </div>
      </div>
    </template>

    <template #footer>
      <button class="btn" :disabled="saveMut.isPending.value" @click="emit('close')">Закрыть</button>
      <button
        class="btn primary"
        :disabled="!dirty || saveMut.isPending.value"
        @click="saveMut.mutate()"
      >
        <span v-if="saveMut.isPending.value" class="spinner" />
        <Icon v-else name="check" :size="11" />
        <span>Сохранить override</span>
      </button>
    </template>
  </Drawer>
</template>
