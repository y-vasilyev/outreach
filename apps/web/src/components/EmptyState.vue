<script setup lang="ts">
import Icon from './Icon.vue';
import type { IconName } from '../lib/icons';

withDefaults(
  defineProps<{
    title: string;
    description?: string;
    icon?: IconName;
  }>(),
  { icon: 'inbox' },
);
</script>

<template>
  <div class="empty-state">
    <div style="width: 36px; height: 36px; border-radius: 8px; background: var(--paper-3); color: var(--ink-3); display: inline-flex; align-items: center; justify-content: center; margin-bottom: 6px;">
      <Icon :name="icon" :size="16" />
    </div>
    <h3>{{ title }}</h3>
    <p v-if="description">{{ description }}</p>
    <div v-if="$slots.action">
      <slot name="action" />
    </div>
  </div>
</template>
