<script setup lang="ts">
import Icon from './Icon.vue';
</script>

<template>
  <div class="filter-bar">
    <span style="color: var(--ink-4); display: inline-flex;"><Icon name="filter" :size="12" /></span>
    <slot />
    <div style="flex: 1;" />
    <slot name="right" />
  </div>
</template>
