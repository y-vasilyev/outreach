<script setup lang="ts">
import { computed } from 'vue';
import Icon from './Icon.vue';

export interface MultiOption {
  value: string;
  label: string;
}

const props = defineProps<{
  modelValue: string[];
  options: MultiOption[];
  /** Tone class when option is on. */
  tone?: 'accent' | 'ok' | 'warn' | 'violet' | '';
}>();

const emit = defineEmits<{ (e: 'update:modelValue', v: string[]): void }>();

const set = computed(() => new Set(props.modelValue ?? []));

function toggle(v: string): void {
  const next = new Set(set.value);
  if (next.has(v)) next.delete(v);
  else next.add(v);
  emit('update:modelValue', [...next]);
}

const tone = props.tone ?? '';
</script>

<template>
  <div style="display: inline-flex; flex-wrap: wrap; gap: 4px;">
    <button
      v-for="o in options"
      :key="o.value"
      type="button"
      :class="['chip', set.has(o.value) ? `applied ${tone}` : '']"
      @click="toggle(o.value)"
    >
      <Icon v-if="set.has(o.value)" name="check" :size="10" :stroke="2.4" />
      <span>{{ o.label }}</span>
    </button>
  </div>
</template>
