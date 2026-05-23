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
import type { TgAccount } from './types';

const props = defineProps<{ open: boolean; account: TgAccount | null }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved', acc: TgAccount): void }>();

const label = ref('');
const phone = ref('');
const role = ref<'parser' | 'outreach' | 'both'>('outreach');
const dailyMsgLimit = ref(40);
const dailyNewLimit = ref(15);
const tags = ref('');
const notes = ref('');

watch(
  [() => props.open, () => props.account],
  ([open, a]) => {
    if (!open) return;
    if (a) {
      label.value = a.label;
      phone.value = a.phone;
      role.value = a.role;
      dailyMsgLimit.value = a.dailyMsgLimit;
      dailyNewLimit.value = a.dailyNewContactLimit;
      tags.value = (a.tags ?? []).join(', ');
      notes.value = a.notes ?? '';
    } else {
      label.value = '';
      phone.value = '';
      role.value = 'outreach';
      dailyMsgLimit.value = 40;
      dailyNewLimit.value = 15;
      tags.value = '';
      notes.value = '';
    }
  },
  { immediate: true },
);

const mut = useMutation({
  mutationFn: async (): Promise<TgAccount> => {
    const body = {
      label: label.value,
      phone: phone.value,
      role: role.value,
      dailyMsgLimit: dailyMsgLimit.value,
      dailyNewContactLimit: dailyNewLimit.value,
      tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean),
      notes: notes.value || undefined,
    };
    if (props.account) return api.patch<TgAccount>(`/tg-accounts/${props.account.id}`, body);
    return api.post<TgAccount>('/tg-accounts', body);
  },
  onSuccess: (a) => {
    toast.success(props.account ? 'Аккаунт сохранён' : 'Аккаунт создан');
    emit('saved', a);
  },
  onError: (e: Error) => toast.error('Не удалось сохранить', e.message),
});
</script>

<template>
  <Modal
    :open="props.open"
    size="lg"
    :title="account ? 'Редактировать TG аккаунт' : 'Новый TG аккаунт'"
    description="После сохранения откроется мастер логина по номеру."
    @close="emit('close')"
  >
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
      <Field label="Метка"><TextInput v-model="label" placeholder="parser-01 / outreach-team" /></Field>
      <Field label="Номер"><TextInput v-model="phone" placeholder="+7..." /></Field>
      <Field label="Роль">
        <SelectInput
          v-model="role as string"
          :options="[
            { value: 'parser', label: 'Парсер (только скрейп)' },
            { value: 'outreach', label: 'Outreach (отправка)' },
            { value: 'both', label: 'Both (универсальный)' },
          ]"
        />
      </Field>
      <Field label="Тэги" help="Через запятую"><TextInput v-model="tags" placeholder="ru, b2b, …" /></Field>
      <Field label="Лимит сообщений в день">
        <input class="input" type="number" :value="dailyMsgLimit" @input="dailyMsgLimit = Number(($event.target as HTMLInputElement).value) || 0" />
      </Field>
      <Field label="Лимит новых контактов в день">
        <input class="input" type="number" :value="dailyNewLimit" @input="dailyNewLimit = Number(($event.target as HTMLInputElement).value) || 0" />
      </Field>
    </div>
    <Field label="Заметки" style="margin-top: 12px;">
      <TextareaInput v-model="notes" :rows="3" />
    </Field>
    <template #footer>
      <button class="btn" :disabled="mut.isPending.value" @click="emit('close')">Отмена</button>
      <button class="btn primary" :disabled="mut.isPending.value || !label || !phone" @click="mut.mutate()">
        <span v-if="mut.isPending.value" class="spinner" />
        <span>Сохранить</span>
      </button>
    </template>
  </Modal>
</template>
