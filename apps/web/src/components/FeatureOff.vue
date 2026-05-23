<script setup lang="ts">
import EmptyState from './EmptyState.vue';

/**
 * Shown when a flag-gated agency-sourcing-matching endpoint answers 404
 * because its server-side feature flag is off. Keeps the page from crashing
 * and tells the operator what to do.
 */
withDefaults(
  defineProps<{ title?: string; flag?: string }>(),
  { title: 'Функция выключена' },
);
</script>

<template>
  <EmptyState
    :title="title"
    :description="
      flag
        ? `Эта функция отключена флагом ${flag}. Включите его на сервере, чтобы пользоваться разделом.`
        : 'Эта функция отключена на сервере. Включите соответствующий флаг, чтобы пользоваться разделом.'
    "
    icon="settings"
  />
</template>
