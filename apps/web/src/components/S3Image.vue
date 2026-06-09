<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import Icon from './Icon.vue';
import { api } from '../lib/api';

/**
 * Generic S3-backed image (blogger-profile-who-is-this): fetches a URL from an
 * API path (presigned GET or a direct public URL) and renders it with a clean
 * fallback. Used for post-example images; mirrors the inbox AttachmentImage.
 */
const props = withDefaults(
  defineProps<{ urlPath: string; alt?: string; size?: number }>(),
  { size: 96 },
);

const errored = ref(false);

const { data, isLoading, isError } = useQuery({
  queryKey: ['s3-image-url', () => props.urlPath],
  queryFn: () => api.get<{ url: string }>(props.urlPath),
  staleTime: 4 * 60 * 1000,
  retry: 0,
});

const url = computed(() => data.value?.url);
const box = computed(() => ({ width: `${props.size}px`, height: `${props.size}px` }));
</script>

<template>
  <div :style="box">
    <div
      v-if="isLoading"
      :style="{ ...box, background: 'var(--paper-3, rgba(0,0,0,0.05))', borderRadius: '6px' }"
    />
    <div
      v-else-if="isError || errored || !url"
      :style="{ ...box, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--line)', borderRadius: '6px', color: 'var(--ink-4)' }"
      title="нет превью"
    >
      <Icon name="eye" :size="14" />
    </div>
    <a v-else :href="url" target="_blank" rel="noreferrer">
      <img
        :src="url"
        :alt="alt ?? 'post'"
        :style="{ ...box, display: 'block', borderRadius: '6px', objectFit: 'cover' }"
        @error="errored = true"
      />
    </a>
  </div>
</template>
