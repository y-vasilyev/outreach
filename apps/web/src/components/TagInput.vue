<script setup lang="ts">
import { ref } from 'vue';
import Icon from './Icon.vue';

const props = defineProps<{
  modelValue: string[];
  placeholder?: string;
}>();

const emit = defineEmits<{ (e: 'update:modelValue', v: string[]): void }>();

const draft = ref('');

function commit(): void {
  const v = draft.value.trim();
  if (!v) return;
  if (!(props.modelValue ?? []).includes(v)) {
    emit('update:modelValue', [...(props.modelValue ?? []), v]);
  }
  draft.value = '';
}

function remove(t: string): void {
  emit('update:modelValue', (props.modelValue ?? []).filter((x) => x !== t));
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    commit();
  } else if (e.key === 'Backspace' && !draft.value && (props.modelValue ?? []).length) {
    emit('update:modelValue', (props.modelValue ?? []).slice(0, -1));
  }
}
</script>

<template>
  <div
    style="
      min-height: 30px;
      padding: 4px 6px;
      border: 1px solid var(--line-2);
      border-radius: var(--r-sm);
      background: var(--paper);
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      align-items: center;
    "
  >
    <span
      v-for="t in modelValue ?? []"
      :key="t"
      class="chip applied"
      style="cursor: default;"
    >
      <span>{{ t }}</span>
      <span class="x" @click="remove(t)" style="cursor: pointer;"><Icon name="x" :size="10" /></span>
    </span>
    <input
      v-model="draft"
      :placeholder="placeholder ?? 'Введите и нажмите Enter'"
      style="
        flex: 1;
        min-width: 120px;
        border: none;
        outline: none;
        font-family: inherit;
        font-size: 12px;
        padding: 2px 4px;
        background: transparent;
        color: var(--ink);
      "
      @keydown="onKey"
      @blur="commit"
    />
  </div>
</template>
