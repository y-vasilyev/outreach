<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useMutation } from '@tanstack/vue-query';
import Modal from '../../components/Modal.vue';
import Field from '../../components/Field.vue';
import TextInput from '../../components/TextInput.vue';
import Icon from '../../components/Icon.vue';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import type { TgAccount } from './types';

type Step = 'phone' | 'code' | 'password' | 'done';

const props = defineProps<{ open: boolean; account: TgAccount }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'done'): void }>();

const step = ref<Step>('phone');
const code = ref('');
const password = ref('');

watch(
  () => props.open,
  (v) => {
    if (v) {
      step.value = 'phone';
      code.value = '';
      password.value = '';
    }
  },
);

const startMut = useMutation({
  mutationFn: () => api.post<{ ok: boolean }>(`/tg-accounts/${props.account.id}/login/start`, {}),
  onSuccess: () => { step.value = 'code'; toast.info('Код отправлен в Telegram'); },
  onError: (e: Error) => toast.error('Не удалось начать вход', e.message),
});

const codeMut = useMutation({
  mutationFn: () => api.post<{ ok?: boolean; needs2FA?: boolean }>(`/tg-accounts/${props.account.id}/login/confirm-code`, { code: code.value }),
  onSuccess: (r) => {
    if (r.needs2FA) { step.value = 'password'; toast.info('Введите пароль 2FA'); }
    else { step.value = 'done'; toast.success('Аккаунт авторизован'); }
  },
  onError: (e: Error) => toast.error('Неверный код', e.message),
});

const pwdMut = useMutation({
  mutationFn: () => api.post<void>(`/tg-accounts/${props.account.id}/login/confirm-password`, { password: password.value }),
  onSuccess: () => { step.value = 'done'; toast.success('Аккаунт авторизован'); },
  onError: (e: Error) => toast.error('Неверный пароль', e.message),
});

interface StepDef { key: Step; label: string; icon: 'key' | 'shield' | 'check_circle' }
const steps: StepDef[] = [
  { key: 'phone', label: 'Номер', icon: 'key' },
  { key: 'code', label: 'Код', icon: 'shield' },
  { key: 'password', label: '2FA', icon: 'shield' },
  { key: 'done', label: 'Готово', icon: 'check_circle' },
];

const order = computed<Record<Step, number>>(() => ({ phone: 0, code: 1, password: 2, done: 3 }));
</script>

<template>
  <Modal
    :open="props.open"
    :title="`Вход: ${account.label} (${account.phone})`"
    description="3 шага: код по SMS / в Telegram → 2FA-пароль (если есть) → готово."
    size="md"
    @close="emit('close')"
  >
    <div class="stepper">
      <template v-for="(s, idx) in steps" :key="s.key">
        <div :class="['step', step === s.key ? 'active' : '', order[step] > idx ? 'passed' : '']">
          <span class="dot-step"><Icon :name="s.icon" :size="12" /></span>
          <span class="label">{{ s.label }}</span>
        </div>
        <span v-if="idx < steps.length - 1" class="line" />
      </template>
    </div>

    <div style="margin-top: 18px; display: flex; flex-direction: column; gap: 12px;">
      <template v-if="step === 'phone'">
        <p style="font-size: 12.5px; color: var(--ink-2); margin: 0;">
          Отправим код подтверждения на <span class="mono cell-strong">{{ account.phone }}</span> в Telegram.
        </p>
        <button class="btn primary" :disabled="startMut.isPending.value" @click="startMut.mutate()" style="align-self: flex-start;">
          <span v-if="startMut.isPending.value" class="spinner" />
          <Icon v-else name="send" :size="11" />
          <span>Отправить код</span>
        </button>
      </template>

      <template v-else-if="step === 'code'">
        <Field label="Код из Telegram">
          <TextInput v-model="code" placeholder="12345" :maxlength="8" autofocus />
        </Field>
        <button class="btn primary" :disabled="codeMut.isPending.value || code.length < 4" @click="codeMut.mutate()" style="align-self: flex-start;">
          <span v-if="codeMut.isPending.value" class="spinner" />
          <span>Подтвердить код</span>
        </button>
      </template>

      <template v-else-if="step === 'password'">
        <Field label="Пароль 2FA">
          <TextInput v-model="password" type="password" autofocus />
        </Field>
        <button class="btn primary" :disabled="pwdMut.isPending.value || !password" @click="pwdMut.mutate()" style="align-self: flex-start;">
          <span v-if="pwdMut.isPending.value" class="spinner" />
          <span>Подтвердить пароль</span>
        </button>
      </template>

      <template v-else>
        <div style="display: flex; gap: 12px; align-items: center; padding: 16px; background: var(--ok-bg); border: 1px solid var(--ok-line); color: var(--ok); border-radius: var(--r-md);">
          <Icon name="check_circle" :size="18" />
          <div>
            <div style="font-weight: 600; font-size: 13px;">Аккаунт {{ account.label }} успешно авторизован</div>
            <div style="font-size: 11.5px;">Сессия зашифрована и сохранена в базе.</div>
          </div>
        </div>
      </template>
    </div>

    <template #footer>
      <button v-if="step === 'done'" class="btn primary" @click="emit('done')">Готово</button>
      <button v-else class="btn" @click="emit('close')">Отмена</button>
    </template>
  </Modal>
</template>
