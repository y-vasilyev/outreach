<script setup lang="ts">
import { ref, watch } from 'vue';
import { useMutation } from '@tanstack/vue-query';
import Modal from '../../components/Modal.vue';
import Field from '../../components/Field.vue';
import TextInput from '../../components/TextInput.vue';
import SelectInput from '../../components/SelectInput.vue';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import type { UserRow } from './types';

const props = defineProps<{ open: boolean; user: UserRow | null }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void }>();

const email = ref('');
const role = ref<'admin' | 'operator' | 'viewer'>('operator');
const password = ref('');

watch(
  [() => props.open, () => props.user],
  ([open, u]) => {
    if (!open) return;
    if (u) {
      email.value = u.email;
      role.value = u.role;
      password.value = '';
    } else {
      email.value = '';
      role.value = 'operator';
      password.value = '';
    }
  },
  { immediate: true },
);

const mut = useMutation({
  mutationFn: () => {
    const body: Record<string, unknown> = { email: email.value, role: role.value };
    if (password.value) body.password = password.value;
    if (props.user) return api.patch<UserRow>(`/users/${props.user.id}`, body);
    return api.post<UserRow>('/users', body);
  },
  onSuccess: () => {
    toast.success(props.user ? 'Пользователь обновлён' : 'Пользователь создан');
    emit('saved');
  },
  onError: (e: Error) => toast.error('Не удалось сохранить', e.message),
});
</script>

<template>
  <Modal :open="props.open" :title="user ? 'Редактировать пользователя' : 'Новый пользователь'" @close="emit('close')">
    <div class="col" style="gap: 12px;">
      <Field label="Email"><TextInput v-model="email" type="email" /></Field>
      <Field label="Роль">
        <SelectInput
          v-model="role as string"
          :options="[
            { value: 'admin', label: 'admin — полный доступ' },
            { value: 'operator', label: 'operator — диалоги и кампании' },
            { value: 'viewer', label: 'viewer — только просмотр' },
          ]"
        />
      </Field>
      <Field :label="user ? 'Новый пароль (оставьте пустым, чтобы не менять)' : 'Пароль'">
        <TextInput v-model="password" type="password" />
      </Field>
    </div>
    <template #footer>
      <button class="btn" :disabled="mut.isPending.value" @click="emit('close')">Отмена</button>
      <button class="btn primary" :disabled="mut.isPending.value || !email || (!user && !password)" @click="mut.mutate()">
        <span v-if="mut.isPending.value" class="spinner" />
        <span>Сохранить</span>
      </button>
    </template>
  </Modal>
</template>
