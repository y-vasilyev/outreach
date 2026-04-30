<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    modelValue: string | undefined;
    placeholder?: string;
    rows?: number;
    disabled?: boolean;
    error?: boolean;
    mono?: boolean;
  }>(),
  { rows: 4 },
);

const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();
const cls = computed(() => `input ${props.error ? 'error' : ''} ${props.mono ? 'mono' : ''}`.trim());

function onInput(e: Event): void {
  emit('update:modelValue', (e.target as HTMLTextAreaElement).value);
}
</script>

<template>
  <textarea :class="cls" :rows="rows" :value="modelValue ?? ''" :placeholder="placeholder" :disabled="disabled" @input="onInput" />
</template>
