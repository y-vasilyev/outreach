<script setup lang="ts">
import { computed } from 'vue';
import { avatarColor } from '../lib/state';

const props = withDefaults(
  defineProps<{
    /** Initials text shown inside. */
    text?: string;
    /** CSS color override; falls back to a hash-stable colour from `seed`. */
    color?: string;
    /** Stable seed for hashed colour when `color` is not provided. */
    seed?: string;
    size?: 'sm' | 'md' | 'lg' | 'xl';
    round?: boolean;
  }>(),
  { size: 'md' },
);

const sizeCls = computed(() => {
  if (props.size === 'lg') return 'lg';
  if (props.size === 'xl') return 'xl';
  return '';
});
const cls = computed(() => `amark ${sizeCls.value} ${props.round ? 'round' : ''}`.trim());
const bg = computed(() => props.color ?? (props.seed ? avatarColor(props.seed) : 'oklch(0.55 0.10 80)'));
</script>

<template>
  <span :class="cls" :style="{ background: bg }">
    <slot>{{ (text ?? '').slice(0, 2).toUpperCase() }}</slot>
  </span>
</template>
