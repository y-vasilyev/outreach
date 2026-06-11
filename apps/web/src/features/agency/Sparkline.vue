<script setup lang="ts">
import { computed } from 'vue';

// Мини-спарклайн динамики метрики (blogger-dynamics): inline SVG, без
// chart-библиотек. Рисуется только при ≥2 точках.
const props = withDefaults(defineProps<{ values: number[]; width?: number; height?: number }>(), {
  width: 64,
  height: 18,
});

const path = computed(() => {
  const vs = props.values;
  if (vs.length < 2) return '';
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const span = max - min || 1;
  const stepX = props.width / (vs.length - 1);
  return vs
    .map((v, i) => {
      const x = (i * stepX).toFixed(1);
      const y = (props.height - 2 - ((v - min) / span) * (props.height - 4)).toFixed(1);
      return `${i === 0 ? 'M' : 'L'}${x},${y}`;
    })
    .join(' ');
});
</script>

<template>
  <svg
    v-if="path"
    :width="width"
    :height="height"
    :viewBox="`0 0 ${width} ${height}`"
    fill="none"
    aria-hidden="true"
    style="color: var(--ink-3); flex: none;"
  >
    <path :d="path" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
</template>
