<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    /** 0..1 (or 0..100 if `pct` is true). */
    value: number;
    pct?: boolean;
    width?: number | string;
    tone?: '' | 'ok' | 'warn' | 'bad';
  }>(),
  { tone: '' },
);

const w = computed(() => {
  const raw = props.pct ? props.value : props.value * 100;
  return `${Math.max(0, Math.min(100, raw))}%`;
});
const cls = computed(() => `bar ${props.tone}`.trim());
const styleAttr = computed(() => (props.width ? { width: typeof props.width === 'number' ? `${props.width}px` : props.width } : {}));
</script>

<template>
  <span :class="cls" :style="styleAttr">
    <i :style="{ width: w }" />
  </span>
</template>
