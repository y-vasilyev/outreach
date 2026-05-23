<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from './Icon.vue';

export interface FilterOption {
  value: string;
  label: string;
}

const props = defineProps<{
  /** Static label rendered before the value (e.g. "Платформа"). */
  label: string;
  /** Empty string = "no filter applied". */
  modelValue: string;
  options: FilterOption[];
  /** Tone class when applied: 'accent' | 'ok' | 'warn' | 'violet'. */
  tone?: '' | 'accent' | 'ok' | 'warn' | 'violet';
  /** Visible label when no value is selected (defaults to "любой"). */
  placeholder?: string;
}>();

const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);

const cls = computed(() => `chip ${props.modelValue ? 'applied' : ''} ${props.tone ?? ''}`.trim());

const valueLabel = computed(() => {
  if (!props.modelValue) return props.placeholder ?? 'любой';
  return props.options.find((o) => o.value === props.modelValue)?.label ?? props.modelValue;
});

function pick(v: string): void {
  emit('update:modelValue', v);
  open.value = false;
}

function clear(): void {
  emit('update:modelValue', '');
  open.value = false;
}

function onClickOutside(e: MouseEvent): void {
  if (!root.value) return;
  if (!root.value.contains(e.target as Node)) open.value = false;
}

onMounted(() => document.addEventListener('mousedown', onClickOutside));
onBeforeUnmount(() => document.removeEventListener('mousedown', onClickOutside));
</script>

<template>
  <div ref="root" style="position: relative; display: inline-flex;">
    <button :class="cls" type="button" @click="open = !open">
      <span>{{ label }}</span>
      <span class="v">{{ valueLabel }}</span>
      <span v-if="modelValue" class="x" @click.stop="clear" :title="`Сбросить ${label.toLowerCase()}`">
        <Icon name="x" :size="10" />
      </span>
    </button>
    <div
      v-if="open"
      class="dropdown-menu"
      style="position: absolute; top: 100%; left: 0; margin-top: 4px; min-width: 180px;"
    >
      <button
        type="button"
        class="dropdown-item"
        :style="{ fontWeight: modelValue === '' ? 500 : 400 }"
        @click="pick('')"
      >
        <Icon v-if="modelValue === ''" name="check" :size="11" />
        <span v-else style="display: inline-block; width: 11px;" />
        <span>{{ placeholder ?? 'любой' }}</span>
      </button>
      <div class="dropdown-divider" />
      <button
        v-for="o in options"
        :key="o.value"
        type="button"
        class="dropdown-item"
        :style="{ fontWeight: modelValue === o.value ? 500 : 400 }"
        @click="pick(o.value)"
      >
        <Icon v-if="modelValue === o.value" name="check" :size="11" />
        <span v-else style="display: inline-block; width: 11px;" />
        <span>{{ o.label }}</span>
      </button>
    </div>
  </div>
</template>
