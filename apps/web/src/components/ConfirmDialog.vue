<script setup lang="ts">
import Modal from './Modal.vue';

withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    description?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
    loading?: boolean;
  }>(),
  {
    confirmLabel: 'Подтвердить',
    cancelLabel: 'Отмена',
  },
);

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'confirm'): void;
}>();
</script>

<template>
  <Modal :open="open" :title="title" size="sm" @close="emit('close')">
    <div v-if="description" style="font-size: 12.5px; color: var(--ink-2); line-height: 1.55;">{{ description }}</div>
    <template #footer>
      <button class="btn" :disabled="loading" @click="emit('close')">{{ cancelLabel }}</button>
      <button :class="['btn', destructive ? 'danger' : 'primary']" :disabled="loading" @click="emit('confirm')">
        <span v-if="loading" class="spinner" />
        <span>{{ confirmLabel }}</span>
      </button>
    </template>
  </Modal>
</template>
