<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import Icon from '../../components/Icon.vue';
import { api } from '../../lib/api';

const props = defineProps<{ assetId: string; alt?: string }>();

const errored = ref(false);

// Presigned URLs expire — short TTL (default 300s server-side). Refetch
// each time the bubble mounts so the URL is always fresh. Cache locally
// so two re-renders of the same image don't double-fetch.
const { data, isLoading, isError } = useQuery({
  queryKey: ['media-asset-url', () => props.assetId],
  queryFn: () => api.get<{ url: string; expiresInSeconds: number }>(`/media-assets/${props.assetId}/download-url`),
  staleTime: 4 * 60 * 1000,
  retry: 1,
});

const url = computed(() => data.value?.url);

function onImgError() {
  errored.value = true;
}
</script>

<template>
  <div :style="{ marginTop: '4px' }">
    <div
      v-if="isLoading"
      :style="{
        width: '220px',
        height: '140px',
        background: 'var(--paper-3, rgba(0,0,0,0.05))',
        borderRadius: '6px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--ink-4)',
        fontSize: '11px',
      }"
    >
      loading…
    </div>
    <div
      v-else-if="isError || errored || !url"
      :style="{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        fontSize: '11px',
        color: 'var(--ink-4)',
      }"
    >
      <Icon name="warn" :size="12" />
      <span>preview unavailable</span>
    </div>
    <a v-else :href="url" target="_blank" rel="noreferrer">
      <img
        :src="url"
        :alt="alt ?? 'image'"
        :style="{
          display: 'block',
          maxWidth: '320px',
          maxHeight: '320px',
          borderRadius: '6px',
          objectFit: 'cover',
        }"
        @error="onImgError"
      />
    </a>
  </div>
</template>
