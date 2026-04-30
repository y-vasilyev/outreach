<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue';
import Icon from './Icon.vue';

const props = withDefaults(
  defineProps<{
    open: boolean;
    title?: string;
    description?: string;
    size?: 'sm' | 'md' | 'lg' | 'xl';
  }>(),
  { size: 'md' },
);

const emit = defineEmits<{ (e: 'close'): void }>();

const cls = computed(() => `modal ${props.size === 'lg' ? 'lg' : props.size === 'xl' ? 'xl' : ''}`.trim());

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close');
}

watch(
  () => props.open,
  (v) => {
    if (v) {
      document.addEventListener('keydown', onKey);
      document.body.style.overflow = 'hidden';
    } else {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey);
  document.body.style.overflow = '';
});
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-overlay" @click.self="emit('close')">
      <div :class="cls" role="dialog" aria-modal="true">
        <div v-if="title || description" class="modal-head">
          <div class="grow">
            <div v-if="title" class="title">{{ title }}</div>
            <div v-if="description" class="desc">{{ description }}</div>
          </div>
          <button class="x" @click="emit('close')" aria-label="Close">
            <Icon name="x" :size="14" />
          </button>
        </div>
        <div class="modal-body">
          <slot />
        </div>
        <div v-if="$slots.footer" class="modal-foot">
          <slot name="footer" />
        </div>
      </div>
    </div>
  </Teleport>
</template>
