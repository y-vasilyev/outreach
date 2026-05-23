<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ value: number }>();

const tone = computed(() => (props.value > 0.85 ? 'ok' : props.value > 0.65 ? '' : 'warn'));
const w = computed(() => `${Math.max(0, Math.min(100, props.value * 100))}%`);
</script>

<template>
  <span :class="['confbar', tone]">
    <i :style="{ width: w }" />
  </span>
</template>
