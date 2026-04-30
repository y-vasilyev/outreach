<script setup lang="ts">
import Icon from '../../components/Icon.vue';

const props = defineProps<{
  modelValue: string;
  fromAccount?: string;
  loading?: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void;
  (e: 'send'): void;
  (e: 'rephrase'): void;
  (e: 'safetyCheck'): void;
}>();

function onInput(e: Event): void {
  emit('update:modelValue', (e.target as HTMLTextAreaElement).value);
}

function onKeyDown(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    if (!props.disabled && (props.modelValue || '').trim()) emit('send');
  }
}
</script>

<template>
  <div style="padding: 10px 14px 14px; border-top: 1px solid var(--line); background: var(--paper); flex: none;">
    <div
      style="border: 1px solid var(--line-2); border-radius: 8px; background: var(--paper); overflow: hidden; box-shadow: var(--shadow-sm);"
    >
      <textarea
        :value="modelValue"
        :disabled="disabled"
        placeholder="Напиши ответ или выбери подсказку выше · ⌘↩ — отправить"
        style="width: 100%; min-height: 78px; resize: vertical; border: none; outline: none; padding: 10px 12px; font-family: inherit; font-size: 13px; color: var(--ink); background: transparent; line-height: 1.5;"
        @input="onInput"
        @keydown="onKeyDown"
      />
      <div
        style="display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-top: 1px solid var(--line); background: var(--paper-2); flex-wrap: wrap;"
      >
        <button class="btn ghost icon-only sm"><Icon name="paperclip" :size="12" /></button>
        <button class="btn ghost icon-only sm"><Icon name="smile" :size="12" /></button>
        <span class="divider-v" />
        <button class="btn ghost sm" title="Перефразировать" @click="emit('rephrase')">
          <Icon name="sparkle" :size="12" />
        </button>
        <button class="btn ghost sm" title="SafetyFilter" @click="emit('safetyCheck')">
          <Icon name="shield" :size="12" />
        </button>
        <div style="flex: 1; min-width: 8px;" />
        <button
          class="btn primary sm"
          :disabled="loading || disabled || !(modelValue || '').trim()"
          @click="emit('send')"
        >
          <span v-if="loading" class="spinner" />
          <Icon v-else name="send" :size="11" />
          <span>Отправить</span>
          <span class="kbd">⌘↩</span>
        </button>
      </div>
      <div v-if="fromAccount" style="padding: 0 10px 6px; display: flex; justify-content: flex-end;">
        <span class="muted-2" style="font-size: 10.5px;">с аккаунта <span class="mono">{{ fromAccount }}</span></span>
      </div>
    </div>
  </div>
</template>
