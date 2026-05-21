<script setup lang="ts">
import { computed } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import PageHead from '../../components/PageHead.vue';
import Switch from '../../components/Switch.vue';
import Pill from '../../components/Pill.vue';
import Spinner from '../../components/Spinner.vue';
import EmptyState from '../../components/EmptyState.vue';
import Icon from '../../components/Icon.vue';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../lib/toast';

/**
 * Settings → Фичи (admin only): the runtime feature-flag control plane
 * (runtime-feature-flags M3). Lists every flag with its resolved state,
 * description, and a NON-BLOCKING readiness hint (prerequisites). Toggling
 * PATCHes the flag, then invalidates both this list and the `/config` query
 * so the nav (useFlags) reflects the change without a reload.
 */

interface FeatureFlagReadiness {
  ready: boolean;
  hint?: string;
}

interface FeatureFlagRow {
  key: string;
  enabled: boolean;
  description: string;
  readiness: FeatureFlagReadiness;
}

const qc = useQueryClient();

const { data, isLoading, isError } = useQuery({
  queryKey: ['feature-flags'],
  queryFn: () => api.get<FeatureFlagRow[]>('/feature-flags'),
});

const list = computed<FeatureFlagRow[]>(() => data.value ?? []);

const toggleMut = useMutation({
  mutationFn: (vars: { key: string; enabled: boolean }) =>
    api.patch<FeatureFlagRow>(`/feature-flags/${vars.key}`, { enabled: vars.enabled }),
  onSuccess: (_res, vars) => {
    // Refetch the flags list AND the public /config snapshot so nav entries
    // gated by useFlags() update live.
    qc.invalidateQueries({ queryKey: ['feature-flags'] });
    qc.invalidateQueries({ queryKey: ['config'] });
    toast.success(vars.enabled ? 'Фича включена' : 'Фича выключена');
  },
  onError: (e: unknown) => {
    const msg = e instanceof ApiError ? e.message : 'Не удалось переключить фичу';
    toast.error(msg);
    // Re-sync UI with server truth (the optimistic v-model already flipped).
    qc.invalidateQueries({ queryKey: ['feature-flags'] });
  },
});

function onToggle(row: FeatureFlagRow, next: boolean): void {
  if (toggleMut.isPending.value) return;
  toggleMut.mutate({ key: row.key, enabled: next });
}
</script>

<template>
  <PageHead
    title="Фичи"
    sub="Рантайм-флаги: включение/выключение возможностей без перезапуска. Изменения аудируются. Доступно только администраторам."
  />

  <div v-if="isLoading" class="center"><Spinner /></div>

  <EmptyState
    v-else-if="isError"
    title="Не удалось загрузить флаги"
    description="Проверьте, что у вас роль администратора, и повторите."
    icon="shield"
  />

  <EmptyState
    v-else-if="list.length === 0"
    title="Флагов нет"
    description="Реестр рантайм-флагов пуст."
    icon="settings"
  />

  <div v-else class="cards" style="grid-template-columns: 1fr;">
    <div v-for="row in list" :key="row.key" class="card flag-card">
      <div class="flag-main">
        <div class="flag-text">
          <div class="flag-title">
            <span class="flag-key">{{ row.key }}</span>
            <Pill :cls="row.enabled ? 'ok' : 'ghost'" :label="row.enabled ? 'Вкл' : 'Выкл'" />
          </div>
          <div v-if="row.description" class="flag-desc">{{ row.description }}</div>
          <div
            v-if="!row.readiness.ready"
            class="flag-hint"
            :title="row.readiness.hint || 'Не все предпосылки настроены'"
          >
            <Icon name="shield" :size="12" />
            <span>{{ row.readiness.hint || 'Не все предпосылки настроены' }}</span>
          </div>
        </div>
        <Switch
          :model-value="row.enabled"
          :disabled="toggleMut.isPending.value"
          @update:model-value="(v: boolean) => onToggle(row, v)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.flag-card {
  padding: 16px;
}
.flag-main {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.flag-text {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.flag-title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.flag-key {
  font-family: var(--mono, monospace);
  font-weight: 600;
}
.flag-desc {
  color: var(--text-muted, #888);
  font-size: 13px;
}
.flag-hint {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--warn, #b8860b);
}
</style>
