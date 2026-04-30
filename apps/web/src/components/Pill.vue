<script setup lang="ts">
import { computed } from 'vue';
import { statePill, type PillClass } from '../lib/state';

const props = defineProps<{
  /** Backend enum string. Looked up in the state map. */
  state?: string;
  /** Override the visible label (defaults to map's label or the raw state). */
  label?: string;
  /** Direct class override; bypasses the state map entirely. */
  cls?: PillClass;
  dot?: boolean;
}>();

const spec = computed(() => statePill(props.state));
const cssClass = computed(() => `pill ${props.cls ?? spec.value.cls}`);
const txt = computed(() => props.label ?? spec.value.txt);
</script>

<template>
  <span :class="cssClass">
    <span v-if="dot ?? true" class="dot" />
    <slot>{{ txt }}</slot>
  </span>
</template>
