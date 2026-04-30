<script setup lang="ts">
withDefaults(defineProps<{ size?: 'sm' | 'md' | 'lg'; label?: string }>(), { size: 'md' });
</script>

<template>
  <span :class="['spinner', size === 'lg' ? 'lg' : '']" :aria-label="label || 'Loading'" />
</template>
