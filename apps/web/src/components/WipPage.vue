<script setup lang="ts">
import Icon from './Icon.vue';
defineProps<{ title: string; sub?: string; stage?: string }>();
</script>

<template>
  <div class="page-head">
    <div>
      <div class="page-title">{{ title }}</div>
      <div v-if="sub" class="page-sub">{{ sub }}</div>
    </div>
  </div>
  <div class="cards">
    <div class="placeholder" style="min-height: 200px;">
      <div style="text-align: center;">
        <div style="display:inline-flex; align-items:center; gap: 8px; color: var(--ink-3); font-family: var(--font-ui); font-size: 13px;">
          <Icon name="loader" :size="14" />
          Этот экран портируется на Vue. Скоро будет готов.
        </div>
        <div v-if="stage" class="muted-2" style="margin-top: 6px;">{{ stage }}</div>
      </div>
    </div>
  </div>
</template>
