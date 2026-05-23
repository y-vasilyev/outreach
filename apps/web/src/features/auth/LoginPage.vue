<script setup lang="ts">
import { ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { login } from '../../lib/auth';
import { ApiError } from '../../lib/api';
import { toast } from '../../lib/toast';

const router = useRouter();
const route = useRoute();

const email = ref('admin@nosquare.local');
const password = ref('');
const submitting = ref(false);
const error = ref<string | null>(null);

async function onSubmit(e: Event): Promise<void> {
  e.preventDefault();
  error.value = null;
  submitting.value = true;
  try {
    await login(email.value, password.value);
    const next = (route.query.next as string | undefined) || '/';
    router.replace(next);
  } catch (err) {
    const ae = err as ApiError;
    error.value = ae.message || 'Не удалось войти';
    toast.error('Ошибка входа', ae.message);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="login-shell">
    <div class="login-card">
      <div class="login-brand">
        <span class="logo" />
        <span class="name">Nosquare Outreach</span>
      </div>
      <div style="text-align: center;">
        <div style="font-size: 16px; font-weight: 600;">Вход в админку</div>
        <div class="muted" style="font-size: 12px; margin-top: 4px;">Используйте корпоративный email и пароль</div>
      </div>
      <form @submit="onSubmit" class="col" style="margin-top: 18px; gap: 12px;">
        <div class="field-row">
          <label class="field-label">Email</label>
          <input
            class="input"
            type="email"
            required
            v-model="email"
            autocomplete="email"
          />
        </div>
        <div class="field-row">
          <label class="field-label">Пароль</label>
          <input
            :class="['input', error ? 'error' : '']"
            type="password"
            required
            v-model="password"
            autocomplete="current-password"
          />
          <div v-if="error" class="field-error">{{ error }}</div>
        </div>
        <button type="submit" class="btn primary lg block" :disabled="submitting">
          <span v-if="submitting" class="spinner" style="border-color: oklch(0.992 0.003 80 / 0.3); border-top-color: var(--paper);" />
          <span>Войти</span>
        </button>
      </form>
      <div class="muted-2" style="text-align: center; margin-top: 14px; font-size: 11px;">
        Забыли пароль? Обратитесь к администратору.
      </div>
    </div>
  </div>
</template>
