<script setup lang="ts">
import { computed } from 'vue';
import { getIcon, type IconName } from '../lib/icons';

const props = withDefaults(
  defineProps<{
    name: IconName;
    size?: number | string;
    stroke?: number;
  }>(),
  {
    size: 14,
    stroke: 1.6,
  },
);

const def = computed(() => getIcon(props.name));
const paths = computed(() => {
  const d = def.value.d;
  return Array.isArray(d) ? d : [d];
});
const fill = computed(() => def.value.fill ?? 'none');
const strokeW = computed(() => def.value.stroke ?? props.stroke);
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    :fill="fill"
    stroke="currentColor"
    :stroke-width="strokeW"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-for="(d, i) in paths" :key="i" :d="d" :stroke="fill === 'currentColor' ? 'none' : undefined" />
  </svg>
</template>
