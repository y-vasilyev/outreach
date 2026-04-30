<script setup lang="ts">
import { useToastStore } from '../lib/toast';
import Icon from './Icon.vue';

const { items, remove } = useToastStore();

const iconFor = (variant: string) =>
  variant === 'success' ? 'check_circle' :
  variant === 'error' ? 'x_circle' :
  variant === 'warning' ? 'warn' :
  'info';
</script>

<template>
  <div class="toast-stack" role="status" aria-live="polite">
    <div v-for="t in items" :key="t.id" :class="['toast', t.variant]">
      <span class="icon"><Icon :name="iconFor(t.variant) as any" :size="16" /></span>
      <div class="grow">
        <div class="title">{{ t.title }}</div>
        <div v-if="t.description" class="desc">{{ t.description }}</div>
      </div>
      <button class="btn ghost icon-only sm" @click="remove(t.id)" aria-label="Close">
        <Icon name="x" :size="11" />
      </button>
    </div>
  </div>
</template>
