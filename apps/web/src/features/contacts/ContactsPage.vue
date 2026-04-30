<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import PageHead from '../../components/PageHead.vue';
import Tabs from '../../components/Tabs.vue';
import FilterBar from '../../components/FilterBar.vue';
import FilterChipSelect from '../../components/FilterChipSelect.vue';
import Pill from '../../components/Pill.vue';
import Tag from '../../components/Tag.vue';
import ConfBar from '../../components/ConfBar.vue';
import Icon from '../../components/Icon.vue';
import Spinner from '../../components/Spinner.vue';
import EmptyState from '../../components/EmptyState.vue';
import Dropdown from '../../components/Dropdown.vue';
import AddToCampaignDialog from './AddToCampaignDialog.vue';
import ContactCreateDialog from './ContactCreateDialog.vue';
import ContactEditDrawer from './ContactEditDrawer.vue';
import StartConversationDialog from './StartConversationDialog.vue';
import { api } from '../../lib/api';
import { useMutation } from '@tanstack/vue-query';
import { toast } from '../../lib/toast';
import { formatRelative } from '../../lib/format';
import type { Contact } from './types';
import type { IconName } from '../../lib/icons';

const qc = useQueryClient();

const tab = ref<'all' | 'new' | 'qualified' | 'contacted' | 'active'>('all');
const typeFilter = ref('');
const roleFilter = ref('');
const reachFilter = ref('');
const minConf = ref('');

const selectedIds = ref<Set<string>>(new Set());
const addToCampaignOpen = ref(false);
const createOpen = ref(false);
const editingContact = ref<Contact | null>(null);
const startChatFor = ref<Contact | null>(null);

const reExtractMut = useMutation({
  mutationFn: (id: string) =>
    api.post<{ ok: true; jobId: string }>(`/contacts/${id}/re-extract`, {}),
  onSuccess: () => {
    toast.info('LLM-extractor поставлен в очередь', 'Канал переобрабатывается');
    qc.invalidateQueries({ queryKey: ['contacts'] });
    qc.invalidateQueries({ queryKey: ['channels'] });
  },
  onError: (e: Error) => toast.error('Не удалось перезапустить', e.message),
});

/**
 * Optimistic status flip. Patches every cached `['contacts', ...]` list
 * immediately so the row reflects the change without waiting for the
 * round-trip; rollback on error. We *also* invalidate on settle so the
 * server is the source of truth for any other field that might have moved
 * (status downstream effects, updatedAt).
 */
type ContactsListData = Contact[] | { items: Contact[]; total?: number } | undefined;
function patchListData(
  data: ContactsListData,
  id: string,
  patch: Partial<Contact>,
): ContactsListData {
  if (!data) return data;
  const items = Array.isArray(data) ? data : data.items;
  if (!items) return data;
  const next = items.map((c) => (c.id === id ? { ...c, ...patch } : c));
  return Array.isArray(data) ? next : { ...data, items: next };
}

const setStatusMut = useMutation({
  mutationFn: (args: { id: string; status: 'qualified' | 'disqualified' | 'new' }) =>
    api.patch<Contact>(`/contacts/${args.id}`, { status: args.status }),
  onMutate: async (args) => {
    await qc.cancelQueries({ queryKey: ['contacts'] });
    const snapshots = qc.getQueriesData<ContactsListData>({ queryKey: ['contacts'] });
    qc.setQueriesData<ContactsListData>({ queryKey: ['contacts'] }, (old) =>
      patchListData(old, args.id, { status: args.status }),
    );
    return { snapshots };
  },
  onError: (e: Error, _args, ctx) => {
    if (ctx?.snapshots) {
      for (const [key, data] of ctx.snapshots) qc.setQueryData(key, data);
    }
    const ae = e as { code?: string; status?: number; message: string };
    toast.error(
      'Не удалось изменить статус',
      `${ae.code ?? ''}${ae.status ? ` ${ae.status}` : ''} ${ae.message}`.trim(),
    );
  },
  onSuccess: (_v, args) => {
    toast.success(`Статус → ${args.status}`);
  },
  onSettled: () => {
    qc.invalidateQueries({ queryKey: ['contacts'] });
  },
});

function rowActions(c: Contact) {
  const items: Array<{
    label: string;
    icon?: IconName;
    onClick?: () => void;
    variant?: 'default' | 'danger';
    divider?: boolean;
  }> = [
    {
      label: 'Начать ai-assisted чат',
      icon: 'zap' as const,
      onClick: () => (startChatFor.value = c),
    },
    {
      label: 'Открыть / редактировать',
      icon: 'edit' as const,
      onClick: () => (editingContact.value = c),
    },
    {
      label: 'Обновить через ИИ',
      icon: 'sparkle' as const,
      onClick: () => reExtractMut.mutate(c.id),
    },
    { label: '', divider: true },
  ];
  if (c.status !== 'qualified') {
    items.push({
      label: 'Пометить qualified',
      icon: 'check' as const,
      onClick: () => setStatusMut.mutate({ id: c.id, status: 'qualified' }),
    });
  }
  if (c.status !== 'disqualified') {
    items.push({
      label: 'Пометить disqualified',
      icon: 'x' as const,
      variant: 'danger' as const,
      onClick: () => setStatusMut.mutate({ id: c.id, status: 'disqualified' }),
    });
  }
  return items;
}

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

/**
 * The DB stores `confidence` as Decimal; some older API responses may surface
 * it as a string. Coerce defensively so `.toFixed` and arithmetic don't crash.
 */
function asConf(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

const filtered = computed<Contact[]>(() => {
  if (!minConf.value) return contacts.value;
  const m = parseFloat(minConf.value);
  return contacts.value.filter((c) => asConf(c.confidence) >= m);
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

const typeOptions = [
  { value: 'tg_username', label: 'tg_username' },
  { value: 'tg_link', label: 'tg_link' },
  { value: 'email', label: 'email' },
  { value: 'website', label: 'website' },
  { value: 'web_form', label: 'web_form' },
  { value: 'other', label: 'other' },
];

const roleOptions = [
  { value: 'owner', label: 'owner' },
  { value: 'ad_manager', label: 'ad_manager' },
  { value: 'generic', label: 'generic' },
  { value: 'bot', label: 'bot' },
  { value: 'unknown', label: 'unknown' },
];

const reachOptions = [
  { value: 'reachable_tg', label: 'reachable_tg' },
  { value: 'manual', label: 'manual' },
  { value: 'unreachable', label: 'unreachable' },
];

const confOptions = [
  { value: '0.5', label: '≥ 0.50' },
  { value: '0.7', label: '≥ 0.70' },
  { value: '0.85', label: '≥ 0.85' },
];

const typeIcon: Record<string, IconName> = {
  tg_username: 'send',
  tg_link: 'link',
  email: 'mail',
  website: 'globe',
  web_form: 'globe',
  other: 'user',
};

function toggleRow(id: string): void {
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
}

const allFilteredSelected = computed(
  () => filtered.value.length > 0 && filtered.value.every((c) => selectedIds.value.has(c.id)),
);

function toggleAll(): void {
  if (allFilteredSelected.value) {
    const next = new Set(selectedIds.value);
    for (const c of filtered.value) next.delete(c.id);
    selectedIds.value = next;
  } else {
    const next = new Set(selectedIds.value);
    for (const c of filtered.value) next.add(c.id);
    selectedIds.value = next;
  }
}

function clearSelection(): void {
  selectedIds.value = new Set();
}

const selectedArray = computed(() => Array.from(selectedIds.value));

function exportCsv(): void {
  const head = 'channel,type,value,role,confidence,reach,status\n';
  const lines = filtered.value.map((c) =>
    [
      c.channel?.title ?? '',
      c.type,
      c.value,
      c.roleGuess,
      asConf(c.confidence),
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
  <PageHead title="Контакты" :sub="`${counts.all} контактов${selectedIds.size ? ` · выбрано ${selectedIds.size}` : ''}`">
    <template #actions>
      <button v-if="selectedIds.size > 0" class="btn ghost" @click="clearSelection">
        <Icon name="x" :size="12" /><span>Снять выделение</span>
      </button>
      <button class="btn" @click="exportCsv"><Icon name="upload" :size="12" /><span>Экспорт CSV</span></button>
      <button class="btn" @click="createOpen = true">
        <Icon name="plus" :size="12" /><span>Добавить</span>
      </button>
      <button
        class="btn primary"
        :disabled="selectedIds.size === 0"
        :title="selectedIds.size === 0 ? 'Сначала выделите контакты' : ''"
        @click="addToCampaignOpen = true"
      >
        <Icon name="zap" :size="12" />
        <span>В кампанию{{ selectedIds.size ? ` (${selectedIds.size})` : '' }}</span>
      </button>
    </template>
  </PageHead>
  <Tabs :tabs="tabsList" :active="tab" @change="(id) => (tab = id as any)" />
  <FilterBar>
    <FilterChipSelect v-model="typeFilter" label="Тип" :options="typeOptions" placeholder="любой" />
    <FilterChipSelect v-model="roleFilter" label="Роль" :options="roleOptions" placeholder="любая" />
    <FilterChipSelect v-model="reachFilter" label="Канал связи" :options="reachOptions" placeholder="любой" />
    <FilterChipSelect v-model="minConf" label="Confidence" :options="confOptions" placeholder="любая" tone="warn" />
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
          <th style="width: 28px;">
            <input type="checkbox" :checked="allFilteredSelected" @change="toggleAll" />
          </th>
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
        <tr
          v-for="c in filtered"
          :key="c.id"
          :class="selectedIds.has(c.id) ? 'selected' : ''"
        >
          <td>
            <input type="checkbox" :checked="selectedIds.has(c.id)" @change="toggleRow(c.id)" />
          </td>
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
          <td>
            <div style="display: flex; align-items: center; gap: 4px;">
              <Pill :state="c.roleGuess" />
              <span
                v-if="c.extractedBy === 'manual'"
                class="mono"
                title="Поправил оператор"
                style="font-size: 9.5px; padding: 1px 4px; background: var(--violet-bg); color: var(--violet); border: 1px solid var(--violet-line); border-radius: 3px;"
              >manual</span>
            </div>
          </td>
          <td>
            <div style="display: flex; align-items: center; gap: 6px;">
              <Tag v-if="c.channel?.platform" :platform="c.channel.platform" />
              <span class="muted ellipsis" style="max-width: 200px;">{{ c.channel?.title || c.channel?.handle || '—' }}</span>
            </div>
          </td>
          <td>
            <div style="display: flex; align-items: center; gap: 6px;">
              <ConfBar :value="asConf(c.confidence)" />
              <span class="mono muted-2" style="font-size: 10.5px;">{{ asConf(c.confidence).toFixed(2) }}</span>
            </div>
          </td>
          <td><Pill :state="c.reachability" /></td>
          <td><Pill :state="c.status" /></td>
          <td class="muted-2 mono" style="font-size: 10.5px;">{{ formatRelative(c.updatedAt) }}</td>
          <td>
            <Dropdown :items="rowActions(c)" align="right">
              <button class="btn ghost icon-only sm"><Icon name="more" :size="12" /></button>
            </Dropdown>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <AddToCampaignDialog
    :open="addToCampaignOpen"
    :contact-ids="selectedArray"
    @close="addToCampaignOpen = false"
    @done="() => {
      addToCampaignOpen = false;
      clearSelection();
      qc.invalidateQueries({ queryKey: ['contacts'] });
      qc.invalidateQueries({ queryKey: ['campaigns'] });
    }"
  />

  <ContactCreateDialog
    :open="createOpen"
    @close="createOpen = false"
    @done="() => {
      createOpen = false;
      qc.invalidateQueries({ queryKey: ['contacts'] });
    }"
  />

  <ContactEditDrawer
    :contact="editingContact"
    @close="editingContact = null"
    @updated="() => qc.invalidateQueries({ queryKey: ['contacts'] })"
  />

  <StartConversationDialog
    :contact="startChatFor"
    @close="startChatFor = null"
    @started="() => { startChatFor = null; qc.invalidateQueries({ queryKey: ['contacts'] }); }"
  />
</template>
