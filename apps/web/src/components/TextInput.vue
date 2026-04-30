<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    modelValue: string | number | undefined;
    type?: string;
    placeholder?: string;
    disabled?: boolean;
    required?: boolean;
    maxlength?: number;
    autofocus?: boolean;
    autocomplete?: string;
    error?: boolean;
    mono?: boolean;
  }>(),
  { type: 'text' },
);

const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();

const cls = computed(() => `input ${props.error ? 'error' : ''} ${props.mono ? 'mono' : ''}`.trim());

function onInput(e: Event): void {
  emit('update:modelValue', (e.target as HTMLInputElement).value);
}
</script>

<template>
  <input
    :class="cls"
    :type="type"
    :value="modelValue ?? ''"
    :placeholder="placeholder"
    :disabled="disabled"
    :required="required"
    :maxlength="maxlength"
    :autofocus="autofocus || undefined"
    :autocomplete="autocomplete"
    @input="onInput"
  />
</template>
