<script setup lang="ts">
import { useRouter } from 'vue-router';
import Icon from './Icon.vue';

defineProps<{
  crumbs?: string[];
}>();

const router = useRouter();
</script>

<template>
  <div class="topbar">
    <div class="crumbs">
      <template v-for="(c, i) in crumbs || []" :key="i">
        <span v-if="i > 0" class="sep">/</span>
        <span :class="i === (crumbs!.length - 1) ? 'here' : ''">{{ c }}</span>
      </template>
    </div>
    <div class="topbar-spacer" />
    <div class="search" role="searchbox" aria-label="Поиск">
      <span style="color: var(--ink-4); display: inline-flex;"><Icon name="search" :size="12" /></span>
      <span>Поиск…</span>
      <span class="kbd">⌘K</span>
    </div>
    <button class="btn ghost icon-only sm" title="Команды">
      <Icon name="command" :size="12" />
    </button>
    <button class="btn ghost icon-only sm" title="Настройки" @click="router.push('/integrations')">
      <Icon name="settings" :size="12" />
    </button>
    <button class="btn primary sm" @click="router.push('/campaigns')">
      <Icon name="zap" :size="11" />
      <span>Активная кампания</span>
    </button>
  </div>
</template>
