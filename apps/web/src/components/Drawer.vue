<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue';
import Icon from './Icon.vue';

const props = defineProps<{ open: boolean; title?: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close');
}

watch(
  () => props.open,
  (v) => {
    if (v) document.addEventListener('keydown', onKey);
    else document.removeEventListener('keydown', onKey);
  },
  { immediate: true },
);

onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
</script>

<template>
  <Teleport to="body">
    <template v-if="open">
      <div class="drawer-overlay" @click="emit('close')" />
      <aside class="drawer" role="dialog" aria-modal="true">
        <div v-if="title || $slots.head" class="modal-head">
          <div class="grow">
            <div v-if="title" class="title">{{ title }}</div>
          </div>
          <slot name="head-actions" />
          <button class="x" @click="emit('close')" aria-label="Close"><Icon name="x" :size="14" /></button>
        </div>
        <div class="modal-body" style="padding: 16px 22px;">
          <slot />
        </div>
        <div v-if="$slots.footer" class="modal-foot">
          <slot name="footer" />
        </div>
      </aside>
    </template>
  </Teleport>
</template>
