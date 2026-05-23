<script setup lang="ts">
export interface TabItem {
  id: string;
  label: string;
  count?: number | string;
}

defineProps<{ tabs: TabItem[]; active: string }>();
const emit = defineEmits<{ (e: 'change', id: string): void }>();
</script>

<template>
  <div class="tabs">
    <button
      v-for="t in tabs"
      :key="t.id"
      type="button"
      :class="['tab', active === t.id ? 'active' : '']"
      @click="emit('change', t.id)"
    >
      <span>{{ t.label }}</span>
      <span v-if="t.count != null" class="count">{{ t.count }}</span>
    </button>
  </div>
</template>
