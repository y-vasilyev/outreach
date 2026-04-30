<script setup lang="ts">
import type { Component } from 'vue';

export interface KvItem {
  label: string;
  value?: string | number | null;
  /** Optional Vue component to render as the value (overrides `value`). */
  component?: Component;
  componentProps?: Record<string, unknown>;
  mono?: boolean;
}

defineProps<{ items: KvItem[] }>();
</script>

<template>
  <dl class="kv">
    <template v-for="(it, i) in items" :key="i">
      <dt>{{ it.label }}</dt>
      <dd>
        <component v-if="it.component" :is="it.component" v-bind="it.componentProps ?? {}" />
        <span v-else :class="it.mono ? 'mono' : ''">{{ it.value ?? '—' }}</span>
      </dd>
    </template>
  </dl>
</template>
