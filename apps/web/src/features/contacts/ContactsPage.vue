<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import PageHead from '../../components/PageHead.vue';
import Tabs from '../../components/Tabs.vue';
import FilterBar from '../../components/FilterBar.vue';
import Chip from '../../components/Chip.vue';
import Pill from '../../components/Pill.vue';
import Tag from '../../components/Tag.vue';
import ConfBar from '../../components/ConfBar.vue';
import Icon from '../../components/Icon.vue';
import Spinner from '../../components/Spinner.vue';
import EmptyState from '../../components/EmptyState.vue';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { formatRelative } from '../../lib/format';
import type { Contact } from './types';
import type { IconName } from '../../lib/icons';

const tab = ref<'all' | 'new' | 'qualified' | 'contacted' | 'active'>('all');
const typeFilter = ref<'' | 'tg_username' | 'tg_link' | 'email' | 'website' | 'web_form' | 'other'>('');
const roleFilter = ref<'' | 'owner' | 'ad_manager' | 'generic' | 'bot' | 'unknown'>('owner');
const reachFilter = ref<'' | 'reachable_tg' | 'manual' | 'unreachable'>('');
const minConf = ref<'' | '0.5' | '0.7' | '0.85'>('0.7');

const queryKey = computed(() => [
  'contacts',
  { tab: tab.value, type: typeFilter.value, role: roleFilter.value, reach: reachFilter.value },
] as const);

const { data, isLoading } = useQuery({
  queryKey,
  queryFn: () => {
    const qs = new URLSearchParams();
    if (typeFilter.value) qs.set('type', typeFilter.value);
    if (roleFilter.value) qs.set('roleGuess', roleFilter.value);
    if (reachFilter.value) qs.set('reachability', reachFilter.value);
    if (tab.value !== 'all') qs.set('status', tab.value);
    return api.get<{ items: Contact[]; total: number } | Contact[]>(`/contacts?${qs.toString()}`);
  },
});

const contacts = computed<Contact[]>(() => {
  const d = data.value;
  if (!d) return [];
  if (Array.isArray(d)) return d;
  return d.items;
});

const filtered = computed<Contact[]>(() => {
  if (!minConf.value) return contacts.value;
  const m = parseFloat(minConf.value);
  return contacts.value.filter((c) => c.confidence >= m);
});

const counts = computed(() => ({
  all: contacts.value.length,
  new: contacts.value.filter((c) => c.status === 'new').length,
  qualified: contacts.value.filter((c) => c.status === 'qualified').length,
  contacted: contacts.value.filter((c) => c.status === 'contacted').length,
  active: contacts.value.filter((c) => c.status === 'active').length,
}));

const tabsList = computed(() => [
  { id: 'all', label: 'Все', count: counts.value.all },
  { id: 'new', label: 'Новые', count: counts.value.new },
  { id: 'qualified', label: 'Qualified', count: counts.value.qualified },
  { id: 'contacted', label: 'Contacted', count: counts.value.contacted },
  { id: 'active', label: 'В диалоге', count: counts.value.active },
]);

const typeIcon: Record<string, IconName> = {
  tg_username: 'send',
  tg_link: 'link',
  email: 'mail',
  website: 'globe',
  web_form: 'globe',
  other: 'user',
};

function exportCsv(): void {
  const head = 'channel,type,value,role,confidence,reach,status\n';
  const lines = filtered.value.map((c) =>
    [
      c.channel?.title ?? '',
      c.type,
      c.value,
      c.roleGuess,
      c.confidence,
      c.reachability,
      c.status,
    ].map((s) => String(s).replace(/,/g, ' ')).join(','),
  );
  const csv = head + lines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `contacts-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast.success('Экспортировано', `${filtered.value.length} контактов`);
}
</script>

<template>
  <PageHead title="Контакты" :sub="`${counts.all} контактов`">
    <template #actions>
      <button class="btn"><Icon name="eye" :size="12" /><span>Колонки</span></button>
      <button class="btn" @click="exportCsv"><Icon name="upload" :size="12" /><span>Экспорт CSV</span></button>
      <button class="btn primary"><Icon name="zap" :size="12" /><span>В кампанию</span></button>
    </template>
  </PageHead>
  <Tabs :tabs="tabsList" :active="tab" @change="(id) => (tab = id as any)" />
  <FilterBar>
    <Chip
      label="Тип"
      :value="typeFilter || 'любой'"
      :applied="!!typeFilter"
      removable
      @click="
        typeFilter =
          typeFilter === '' ? 'tg_username'
          : typeFilter === 'tg_username' ? 'email'
          : typeFilter === 'email' ? 'website'
          : (''  as any)
      "
      @remove="typeFilter = ''"
    />
    <Chip
      label="Роль"
      :value="roleFilter || 'любая'"
      :applied="!!roleFilter"
      removable
      @click="
        roleFilter =
          roleFilter === '' ? 'owner'
          : roleFilter === 'owner' ? 'ad_manager'
          : roleFilter === 'ad_manager' ? 'generic'
          : (''  as any)
      "
      @remove="roleFilter = ''"
    />
    <Chip
      label="Канал связи"
      :value="reachFilter || 'любой'"
      :applied="!!reachFilter"
      removable
      @click="
        reachFilter =
          reachFilter === '' ? 'reachable_tg'
          : reachFilter === 'reachable_tg' ? 'manual'
          : reachFilter === 'manual' ? 'unreachable'
          : ('' as any)
      "
      @remove="reachFilter = ''"
    />
    <Chip
      label="Confidence"
      :value="minConf ? `≥ ${minConf}` : 'любая'"
      :applied="!!minConf"
      tone="warn"
      removable
      @click="
        minConf =
          minConf === '0.7' ? '0.85'
          : minConf === '0.85' ? '0.5'
          : '0.7'
      "
      @remove="minConf = ''"
    />
    <template #right>
      <span class="muted-2">{{ filtered.length }} из {{ contacts.length }}</span>
    </template>
  </FilterBar>

  <div v-if="isLoading" class="center"><Spinner /></div>
  <EmptyState
    v-else-if="filtered.length === 0"
    title="Контактов нет"
    description="После скрейпа агент извлечёт контакты автоматически."
    icon="users_round"
  />
  <div v-else class="table-wrap">
    <table class="tbl">
      <thead>
        <tr>
          <th style="width: 28px;"><input type="checkbox" /></th>
          <th>Контакт</th>
          <th>Тип</th>
          <th>Роль</th>
          <th>Канал</th>
          <th style="width: 110px;">Уверенность</th>
          <th>Канал связи</th>
          <th>Состояние</th>
          <th>Активность</th>
          <th style="width: 28px;"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="c in filtered" :key="c.id">
          <td><input type="checkbox" /></td>
          <td>
            <div style="display: flex; align-items: center; gap: 8px;">
              <span style="width: 22px; height: 22px; border-radius: 5px; background: var(--paper-3); border: 1px solid var(--line); display: inline-flex; align-items: center; justify-content: center; color: var(--ink-3);">
                <Icon :name="typeIcon[c.type] ?? 'user'" :size="12" />
              </span>
              <div style="min-width: 0;">
                <div class="mono cell-strong ellipsis">{{ c.value }}</div>
                <div v-if="c.label" class="muted ellipsis" style="font-size: 11px; font-style: italic;">«{{ c.label }}»</div>
              </div>
            </div>
          </td>
          <td><span class="muted mono">{{ c.type }}</span></td>
          <td><Pill :state="c.roleGuess" /></td>
          <td>
            <div style="display: flex; align-items: center; gap: 6px;">
              <Tag v-if="c.channel?.platform" :platform="c.channel.platform" />
              <span class="muted ellipsis" style="max-width: 200px;">{{ c.channel?.title || c.channel?.handle || '—' }}</span>
            </div>
          </td>
          <td>
            <div style="display: flex; align-items: center; gap: 6px;">
              <ConfBar :value="c.confidence" />
              <span class="mono muted-2" style="font-size: 10.5px;">{{ c.confidence.toFixed(2) }}</span>
            </div>
          </td>
          <td><Pill :state="c.reachability" /></td>
          <td><Pill :state="c.status" /></td>
          <td class="muted-2 mono" style="font-size: 10.5px;">{{ formatRelative(c.updatedAt) }}</td>
          <td><button class="btn ghost icon-only sm"><Icon name="more" :size="12" /></button></td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
