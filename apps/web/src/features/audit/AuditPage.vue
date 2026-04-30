<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import PageHead from '../../components/PageHead.vue';
import FilterBar from '../../components/FilterBar.vue';
import Chip from '../../components/Chip.vue';
import Pill from '../../components/Pill.vue';
import Field from '../../components/Field.vue';
import TextInput from '../../components/TextInput.vue';
import SelectInput from '../../components/SelectInput.vue';
import Spinner from '../../components/Spinner.vue';
import EmptyState from '../../components/EmptyState.vue';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import type { PillClass } from '../../lib/state';

interface AuditEntry {
  id: string;
  userId: string | null;
  user?: { email: string };
  action: string;
  targetType: string;
  targetId: string | null;
  payload?: Record<string, unknown> | null;
  createdAt: string;
}

const search = ref('');
const action = ref('');

const queryKey = computed(() => ['audit', { search: search.value, action: action.value }] as const);

const { data, isLoading } = useQuery({
  queryKey,
  queryFn: () => {
    const qs = new URLSearchParams();
    if (search.value) qs.set('search', search.value);
    if (action.value) qs.set('action', action.value);
    return api.get<AuditEntry[]>(`/audit?${qs.toString()}`);
  },
  refetchInterval: 60_000,
});

const list = computed<AuditEntry[]>(() => data.value ?? []);

function actionTone(a: string): PillClass {
  if (a.startsWith('login')) return 'ghost';
  if (a.includes('delete')) return 'bad';
  if (a.includes('pause')) return 'warn';
  if (a.includes('run') || a.includes('start')) return 'ok';
  if (a.includes('update') || a.includes('patch')) return 'accent';
  return 'violet';
}
</script>

<template>
  <PageHead title="Аудит" sub="Все опасные действия операторов и системных процессов." />
  <FilterBar>
    <div style="display: flex; gap: 8px; align-items: center; flex: 1; max-width: 480px;">
      <Field><TextInput v-model="search" placeholder="Поиск по target_id / user…" /></Field>
      <Field>
        <SelectInput
          v-model="action"
          :options="[
            { value: '', label: 'Любое действие' },
            { value: 'login', label: 'login' },
            { value: 'channel.import', label: 'channel.import' },
            { value: 'campaign.run', label: 'campaign.run' },
            { value: 'campaign.pause', label: 'campaign.pause' },
            { value: 'agent.update', label: 'agent.update' },
            { value: 'tg-account.create', label: 'tg-account.create' },
            { value: 'conversation.escalate', label: 'conversation.escalate' },
          ]"
        />
      </Field>
    </div>
    <Chip
      v-if="search"
      label="search"
      :value="search"
      applied
      removable
      @click="search = ''"
      @remove="search = ''"
    />
    <Chip
      v-if="action"
      label="action"
      :value="action"
      applied
      removable
      @click="action = ''"
      @remove="action = ''"
    />
    <template #right>
      <span class="muted-2">{{ list.length }}</span>
    </template>
  </FilterBar>

  <div v-if="isLoading" class="center"><Spinner /></div>
  <EmptyState v-else-if="list.length === 0" title="Записей нет" icon="shield" />
  <div v-else class="table-wrap">
    <table class="tbl">
      <thead>
        <tr>
          <th style="width: 180px;">Когда</th>
          <th>Кто</th>
          <th>Действие</th>
          <th>Объект</th>
          <th>Payload</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="e in list" :key="e.id">
          <td class="muted-2 mono" style="font-size: 11px;">{{ formatDateTime(e.createdAt) }}</td>
          <td>{{ e.user?.email ?? e.userId ?? 'system' }}</td>
          <td><Pill :cls="actionTone(e.action)" :label="e.action" :dot="false" /></td>
          <td>
            <div>
              <div class="cell-strong">{{ e.targetType }}</div>
              <div class="mono muted-2" style="font-size: 10.5px;">{{ e.targetId ?? '—' }}</div>
            </div>
          </td>
          <td>
            <code v-if="e.payload" class="mono ellipsis muted" style="font-size: 11px; max-width: 360px; display: inline-block;">{{ JSON.stringify(e.payload) }}</code>
            <span v-else class="muted-2">—</span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
