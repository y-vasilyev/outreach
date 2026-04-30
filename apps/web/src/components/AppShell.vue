<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import Rail from './Rail.vue';
import Topbar from './Topbar.vue';
import { api } from '../lib/api';

interface DashboardCounts {
  channels?: { total?: number };
  contacts?: { total?: number };
  conversations?: { active?: number };
  campaigns?: { running?: number };
}

const route = useRoute();

// Soft request to populate badges; failures silently fall through to no badges.
const { data } = useQuery({
  queryKey: ['rail-counts'],
  queryFn: () => api.get<DashboardCounts>('/metrics/dashboard'),
  retry: false,
  staleTime: 60_000,
  refetchInterval: 60_000,
});

const counts = computed(() => ({
  inbox: data.value?.conversations?.active,
  campaigns: data.value?.campaigns?.running,
  channels: data.value?.channels?.total,
  contacts: data.value?.contacts?.total,
}));

const crumbs = computed<string[]>(() => {
  const meta = route.meta?.crumbs as string[] | undefined;
  if (!meta) return [];
  return meta;
});
</script>

<template>
  <div class="app">
    <Rail :counts="counts" />
    <main class="main">
      <Topbar :crumbs="crumbs" />
      <RouterView />
    </main>
  </div>
</template>
