<script setup lang="ts">
import { computed } from 'vue';
import { PLATFORM_CLASS, PLATFORM_LABEL } from '../lib/state';

const props = defineProps<{
  /** Platform: 'telegram' | 'instagram' | 'youtube' (or short form 'tg'/'ig'/'yt'). */
  platform?: string;
}>();

const cls = computed(() => props.platform ? `tag ${PLATFORM_CLASS[props.platform] ?? ''}` : 'tag');
const txt = computed(() => props.platform ? (PLATFORM_LABEL[props.platform] ?? props.platform) : '');
</script>

<template>
  <span :class="cls">
    <slot>{{ txt }}</slot>
  </span>
</template>
