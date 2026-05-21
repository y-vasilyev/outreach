<script setup lang="ts">
import { ref } from 'vue';
import Icon from '../../components/Icon.vue';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../lib/toast';
import type { PresignedUrl } from './types';

/**
 * Fetches a short-lived presigned URL for a media asset and opens it.
 * Handles the honest-pending case: the API answers 409 when the asset row
 * exists but its bytes were never downloaded/stored (no S3 object yet).
 */
const props = defineProps<{ assetId: string; label?: string; mime?: string | null }>();

const loading = ref(false);

async function open(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  try {
    const res = await api.get<PresignedUrl>(`/media-assets/${props.assetId}/download-url`);
    window.open(res.url, '_blank', 'noopener,noreferrer');
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      toast.info('Файл ещё не загружен', 'Медиа-кит получен, но байты пока не скачаны. Попробуйте позже.');
    } else if (e instanceof ApiError && e.status === 404) {
      toast.error('Недоступно', 'Хранилище медиа отключено или файл не найден.');
    } else {
      toast.error('Не удалось получить ссылку', (e as Error).message);
    }
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <button class="btn sm" :disabled="loading" @click="open">
    <span v-if="loading" class="spinner" />
    <Icon v-else name="download" :size="11" />
    <span>{{ label ?? 'Скачать' }}</span>
  </button>
</template>
