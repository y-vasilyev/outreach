<script setup lang="ts">
import { computed } from 'vue';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

const props = defineProps<{
  modelValue: string;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  error?: boolean;
}>();

const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();
const cls = computed(() => `input ${props.error ? 'error' : ''}`.trim());

function onChange(e: Event): void {
  emit('update:modelValue', (e.target as HTMLSelectElement).value);
}
</script>

<template>
  <select :class="cls" :value="modelValue" :disabled="disabled" @change="onChange">
    <option v-if="placeholder" value="" disabled>{{ placeholder }}</option>
    <option v-for="o in options" :key="o.value" :value="o.value" :disabled="o.disabled">
      {{ o.label }}
    </option>
  </select>
</template>
