<script setup lang="ts">
import { computed, ref } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import PageHead from '../../components/PageHead.vue';
import FilterBar from '../../components/FilterBar.vue';
import FilterChipSelect from '../../components/FilterChipSelect.vue';
import Tag from '../../components/Tag.vue';
import Pill from '../../components/Pill.vue';
import Icon from '../../components/Icon.vue';
import Spinner from '../../components/Spinner.vue';
import EmptyState from '../../components/EmptyState.vue';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { formatRelative, truncate } from '../../lib/format';
import type { Contact } from '../contacts/types';

interface DraftResp {
  text: string;
  channel?: { title?: string; description?: string };
  analysis?: Record<string, unknown>;
}

const qc = useQueryClient();

const typeFilter = ref('');
const statusFilter = ref('new');
const selected = ref<Contact | null>(null);

const typeOptions = [
  { value: 'email', label: 'email' },
  { value: 'website', label: 'website' },
  { value: 'web_form', label: 'web_form' },
  { value: 'other', label: 'other' },
];
const statusOptions = [
  { value: 'new', label: 'new' },
  { value: 'contacted', label: 'contacted' },
  { value: 'finished', label: 'finished' },
];

const queryKey = computed(() => ['contacts-manual', { type: typeFilter.value, status: statusFilter.value }] as const);

const { data, isLoading } = useQuery({
  queryKey,
  queryFn: () => {
    const qs = new URLSearchParams();
    qs.set('reachability', 'manual');
    if (typeFilter.value) qs.set('type', typeFilter.value);
    if (statusFilter.value) qs.set('status', statusFilter.value);
    return api.get<{ items: Contact[] } | Contact[]>(`/contacts?${qs.toString()}`);
  },
});

const list = computed<Contact[]>(() => {
  const d = data.value;
  if (!d) return [];
  if (Array.isArray(d)) return d;
  return d.items;
});

const { data: draft, isLoading: draftLoading } = useQuery({
  queryKey: ['contact-draft', () => selected.value?.id],
  queryFn: () => api.get<DraftResp>(`/contacts/${selected.value!.id}/draft`),
  enabled: computed(() => !!selected.value),
});

const markMut = useMutation({
  mutationFn: ({ id, status }: { id: string; status: string }) => api.patch<void>(`/contacts/${id}`, { status }),
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: ['contacts-manual'] });
    toast.success('Статус контакта обновлён');
  },
});

const copied = ref(false);
async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
    toast.success('Скопировано в буфер');
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    toast.error('Не удалось скопировать');
  }
}
</script>

<template>
  <PageHead title="Manual outreach" sub="Контакты без TG: email, web-форма, IG. Агент готовит черновик — оператор пишет сам." />
  <FilterBar>
    <FilterChipSelect v-model="typeFilter" label="Тип" :options="typeOptions" placeholder="любой" />
    <FilterChipSelect v-model="statusFilter" label="Статус" :options="statusOptions" placeholder="любой" />
    <template #right>
      <span class="muted-2">{{ list.length }}</span>
    </template>
  </FilterBar>

  <div style="display: grid; grid-template-columns: 320px 1fr; flex: 1; min-height: 0; height: calc(100vh - var(--topbar) - 92px);">
    <div style="border-right: 1px solid var(--line); overflow: auto; background: var(--paper-2);">
      <div v-if="isLoading" class="center"><Spinner /></div>
      <EmptyState
        v-else-if="list.length === 0"
        title="Контактов нет"
        description="Сюда попадают email/web-form контакты, до которых нет TG-связи."
        icon="mail"
      />
      <ul v-else style="margin: 0; padding: 0; list-style: none;">
        <li
          v-for="c in list"
          :key="c.id"
          @click="selected = c"
          :style="{
            padding: '10px 12px',
            cursor: 'pointer',
            background: selected?.id === c.id ? 'var(--paper)' : 'transparent',
            borderLeft: `2px solid ${selected?.id === c.id ? 'var(--ink)' : 'transparent'}`,
            borderBottom: '1px solid var(--line)',
          }"
        >
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="mono cell-strong ellipsis" style="flex: 1;">{{ c.value }}</span>
            <Tag>{{ c.type }}</Tag>
          </div>
          <div style="display: flex; align-items: center; gap: 6px; margin-top: 4px;">
            <span class="muted ellipsis" style="font-size: 11px; flex: 1;">{{ c.channel?.title ?? c.channel?.handle ?? '—' }}</span>
            <Pill :state="c.status" />
          </div>
        </li>
      </ul>
    </div>

    <div style="overflow: auto; padding: 16px 22px;">
      <template v-if="selected">
        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px;">
          <div style="min-width: 0;">
            <div class="cell-strong" style="font-size: 16px;">{{ selected.channel?.title ?? selected.channel?.handle ?? '—' }}</div>
            <div style="display: flex; align-items: center; gap: 6px; margin-top: 6px;">
              <Tag>{{ selected.type }}</Tag>
              <Pill :state="selected.roleGuess" />
              <span class="mono">{{ selected.value }}</span>
            </div>
          </div>
          <div style="display: flex; gap: 6px;">
            <button class="btn sm" @click="markMut.mutate({ id: selected.id, status: 'contacted' })">Отметить «contacted»</button>
            <button class="btn sm" @click="markMut.mutate({ id: selected.id, status: 'finished' })">Закрыть</button>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <Icon name="sparkle" :size="12" /><span>Черновик от агента</span>
            <div class="actions">
              <button class="btn sm" :disabled="!draft?.text" @click="draft?.text && copy(draft.text)">
                <Icon :name="copied ? 'check' : 'copy'" :size="11" /><span>{{ copied ? 'Скопировано' : 'Копировать' }}</span>
              </button>
            </div>
          </div>
          <div class="card-body">
            <div v-if="draftLoading" class="center"><Spinner /></div>
            <p v-else-if="draft?.text" style="white-space: pre-wrap; font-size: 12.5px; color: var(--ink-2); line-height: 1.55; margin: 0;">{{ draft.text }}</p>
            <div v-else class="placeholder" style="min-height: 80px;">Черновик ещё не сгенерирован.</div>
          </div>
        </div>

        <div v-if="draft?.channel?.description" class="card" style="margin-top: 12px;">
          <div class="card-head"><span>Описание канала</span></div>
          <div class="card-body">
            <p style="white-space: pre-wrap; font-size: 12.5px; color: var(--ink-2); line-height: 1.55; margin: 0;">{{ truncate(draft.channel.description, 1200) }}</p>
          </div>
        </div>

        <div v-if="draft?.analysis" class="card" style="margin-top: 12px;">
          <div class="card-head"><span>Анализ</span></div>
          <pre class="card-body mono" style="margin: 0; padding: 12px; max-height: 240px; overflow: auto; font-size: 11px;">{{ JSON.stringify(draft.analysis, null, 2) }}</pre>
        </div>

        <div class="muted-2" style="margin-top: 14px; font-size: 11px;">Обновлён: {{ formatRelative(selected.updatedAt) }}</div>
      </template>
      <EmptyState
        v-else
        title="Выберите контакт"
        description="Слева — контакты для ручного аутрича. Здесь будет канал, анализ и черновик."
        icon="mail"
      />
    </div>
  </div>
</template>
