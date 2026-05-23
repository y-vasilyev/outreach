<script setup lang="ts">
import { computed } from 'vue';
import Icon from './Icon.vue';

const props = defineProps<{
  label: string;
  value?: string | number;
  applied?: boolean;
  removable?: boolean;
  /** Tone class when applied: 'accent' | 'ok' | 'warn' | 'violet'. */
  tone?: '' | 'accent' | 'ok' | 'warn' | 'violet';
}>();

const emit = defineEmits<{ (e: 'click'): void; (e: 'remove'): void }>();

const cls = computed(() => `chip ${props.applied ? 'applied' : ''} ${props.tone ?? ''}`.trim());
</script>

<template>
  <button :class="cls" type="button" @click="emit('click')">
    <span>{{ label }}</span>
    <span v-if="value !== undefined && value !== ''" class="v">{{ value }}</span>
    <span v-if="applied && removable" class="x" @click.stop="emit('remove')">
      <Icon name="x" :size="10" />
    </span>
  </button>
</template>
