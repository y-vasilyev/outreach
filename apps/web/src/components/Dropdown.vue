<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from './Icon.vue';
import type { IconName } from '../lib/icons';

export interface DropdownItem {
  label: string;
  icon?: IconName;
  onClick?: () => void;
  href?: string;
  variant?: 'default' | 'danger';
  disabled?: boolean;
  divider?: boolean;
}

const props = defineProps<{
  items: DropdownItem[];
  align?: 'left' | 'right';
}>();

const emit = defineEmits<{ (e: 'select', item: DropdownItem): void }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);

function toggle(): void { open.value = !open.value; }
function close(): void { open.value = false; }

function pick(it: DropdownItem): void {
  if (it.disabled) return;
  if (it.onClick) it.onClick();
  emit('select', it);
  close();
}

function onClickOutside(e: MouseEvent): void {
  if (!root.value) return;
  if (!root.value.contains(e.target as Node)) close();
}

onMounted(() => document.addEventListener('mousedown', onClickOutside));
onBeforeUnmount(() => document.removeEventListener('mousedown', onClickOutside));
</script>

<template>
  <div class="dropdown" ref="root">
    <span @click="toggle"><slot /></span>
    <div v-if="open" :class="['dropdown-menu', props.align === 'left' ? '' : 'right']" style="top: 100%; margin-top: 4px;">
      <template v-for="(it, i) in items" :key="i">
        <div v-if="it.divider" class="dropdown-divider" />
        <a
          v-else-if="it.href"
          :href="it.href"
          :class="['dropdown-item', it.variant === 'danger' ? 'danger' : '']"
          @click="close"
        >
          <Icon v-if="it.icon" :name="it.icon" :size="13" />
          <span>{{ it.label }}</span>
        </a>
        <button
          v-else
          type="button"
          :class="['dropdown-item', it.variant === 'danger' ? 'danger' : '']"
          :disabled="it.disabled"
          @click="pick(it)"
        >
          <Icon v-if="it.icon" :name="it.icon" :size="13" />
          <span>{{ it.label }}</span>
        </button>
      </template>
    </div>
  </div>
</template>
