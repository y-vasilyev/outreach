<script setup lang="ts">
defineProps<{ label?: string; help?: string; error?: string | null }>();
</script>

<template>
  <div class="field-row">
    <label v-if="label" class="field-label">{{ label }}</label>
    <slot />
    <div v-if="error" class="field-error">{{ error }}</div>
    <div v-else-if="help" class="field-help">{{ help }}</div>
  </div>
</template>
