<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import Chip from '../../components/Chip.vue';
import Icon from '../../components/Icon.vue';
import { api } from '../../lib/api';
import type { InboxFilters } from './filters';

interface CampaignSummary {
  id: string;
  name: string;
}

const props = defineProps<{ modelValue: InboxFilters }>();
const emit = defineEmits<{ (e: 'update:modelValue', v: Partial<InboxFilters>): void }>();

const { data: campaigns } = useQuery({
  queryKey: ['campaigns'],
  queryFn: () => api.get<CampaignSummary[]>('/campaigns'),
});

const campaignOptions = computed(() => {
  const items = campaigns.value ?? [];
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
});

const STATUS_OPTIONS: Array<{ value: NonNullable<InboxFilters['status']>; label: string }> = [
  { value: 'active', label: 'Активен' },
  { value: 'paused', label: 'Пауза' },
  { value: 'done', label: 'Завершён' },
  { value: 'failed', label: 'Ошибка' },
  { value: 'archived', label: 'Архив' },
];
const MODE_OPTIONS: Array<{ value: NonNullable<InboxFilters['mode']>; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'semi_auto', label: 'Semi-auto' },
  { value: 'assisted', label: 'Assisted' },
  { value: 'manual', label: 'Manual' },
];
const ACTIVITY_OPTIONS: Array<{ value: NonNullable<InboxFilters['activity']>; label: string }> = [
  { value: 'i_messaged', label: 'Я написал' },
  { value: 'not_messaged', label: 'Ещё не написал' },
  { value: 'they_replied', label: 'Мне ответили' },
];

// q input has a 250ms debounce so typing doesn't push a router entry per
// keystroke. Local ref drives the input; debounced commit flows up.
const localQ = ref(props.modelValue.q ?? '');
let qTimer: ReturnType<typeof setTimeout> | null = null;

watch(
  () => props.modelValue.q,
  (next) => {
    // External changes (URL navigation, Clear all) reset the input.
    if ((next ?? '') !== localQ.value) localQ.value = next ?? '';
  },
);

function onQInput(e: Event): void {
  localQ.value = (e.target as HTMLInputElement).value;
  if (qTimer) clearTimeout(qTimer);
  qTimer = setTimeout(() => {
    emit('update:modelValue', { q: localQ.value || undefined });
  }, 250);
}

onBeforeUnmount(() => {
  // Make sure a pending debounce doesn't fire after the component has
  // been torn down (e.g. router navigation away from the inbox).
  if (qTimer) clearTimeout(qTimer);
});

function setCampaign(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  emit('update:modelValue', { campaignId: v || undefined });
}
function setStatus(e: Event): void {
  const v = (e.target as HTMLSelectElement).value as InboxFilters['status'] | '';
  emit('update:modelValue', { status: v || undefined });
}
function setMode(e: Event): void {
  const v = (e.target as HTMLSelectElement).value as InboxFilters['mode'] | '';
  emit('update:modelValue', { mode: v || undefined });
}
function setActivity(e: Event): void {
  const v = (e.target as HTMLSelectElement).value as InboxFilters['activity'] | '';
  emit('update:modelValue', { activity: v || undefined });
}

function clearAll(): void {
  // `assignedOperatorId` is intentionally not cleared — see Decision 5
  // and task 5.3/5.4: a deep-link operator filter only goes away when
  // the operator explicitly removes its chip.
  emit('update:modelValue', {
    campaignId: undefined,
    status: undefined,
    mode: undefined,
    activity: undefined,
    q: undefined,
  });
  localQ.value = '';
}

function clearAssignedOperator(): void {
  emit('update:modelValue', { assignedOperatorId: undefined });
}

// Collapsible filter bar (it grew tall enough to eat list space). State is
// persisted so the operator's choice survives navigation/reload.
const COLLAPSE_KEY = 'inbox-filters-collapsed';
const collapsed = ref(readCollapsed());
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}
function toggleCollapsed(): void {
  collapsed.value = !collapsed.value;
  try {
    localStorage.setItem(COLLAPSE_KEY, collapsed.value ? '1' : '0');
  } catch {
    // private mode / storage disabled — collapse still works for the session.
  }
}

// Number of applied filters, shown as a badge so a collapsed bar still signals
// that the list is narrowed (incl. the deep-linked operator filter).
const activeCount = computed(() => {
  const f = props.modelValue;
  return [f.campaignId, f.status, f.mode, f.activity, f.q, f.assignedOperatorId].filter(
    Boolean,
  ).length;
});

const hasResettable = computed(
  () => Boolean(
    props.modelValue.campaignId
    || props.modelValue.status
    || props.modelValue.mode
    || props.modelValue.activity
    || props.modelValue.q,
  ),
);
</script>

<template>
  <div class="inbox-filters-wrap">
    <div class="filters-head">
      <button
        class="btn ghost sm filters-toggle"
        type="button"
        :aria-expanded="!collapsed"
        :title="collapsed ? 'Развернуть фильтры' : 'Свернуть фильтры'"
        @click="toggleCollapsed"
      >
        <Icon name="sliders" :size="12" />
        <span>Фильтры</span>
        <span v-if="activeCount" class="count-badge">{{ activeCount }}</span>
        <Icon name="chev_down" :size="11" :class="['chev', { open: !collapsed }]" />
      </button>
      <button
        v-if="collapsed && hasResettable"
        class="btn ghost sm"
        type="button"
        title="Сбросить фильтры"
        @click="clearAll"
      >
        <Icon name="x" :size="11" />
        <span>Сбросить</span>
      </button>
    </div>

    <div v-show="!collapsed" class="inbox-filters">
    <label class="f-group" style="flex: 1 1 140px; max-width: 180px;">
      <span class="f-label">Кампания</span>
      <select class="input sm" :value="modelValue.campaignId ?? ''" @change="setCampaign" aria-label="Фильтр по кампании">
        <option value="">Все кампании</option>
        <option v-for="c in campaignOptions" :key="c.id" :value="c.id">{{ c.name }}</option>
      </select>
    </label>

    <label class="f-group" style="max-width: 150px;">
      <span class="f-label">Переписка</span>
      <select class="input sm" :value="modelValue.activity ?? ''" @change="setActivity" aria-label="Фильтр по направлению переписки">
        <option value="">Любая</option>
        <option v-for="o in ACTIVITY_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </label>

    <label class="f-group" style="max-width: 130px;">
      <span class="f-label">Статус</span>
      <select class="input sm" :value="modelValue.status ?? ''" @change="setStatus" aria-label="Фильтр по статусу">
        <option value="">Любой статус</option>
        <option v-for="o in STATUS_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </label>

    <label class="f-group" style="max-width: 130px;">
      <span class="f-label">Режим</span>
      <select class="input sm" :value="modelValue.mode ?? ''" @change="setMode" aria-label="Фильтр по режиму">
        <option value="">Любой режим</option>
        <option v-for="o in MODE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </label>

    <label class="f-group" style="flex: 2 1 180px; min-width: 140px;">
      <span class="f-label">Поиск</span>
      <input
        class="input sm"
        type="text"
        :value="localQ"
        @input="onQInput"
        placeholder="Контакт / канал"
        maxlength="200"
        aria-label="Поиск по контакту или каналу"
      />
    </label>

    <button
      v-if="hasResettable"
      class="btn ghost sm f-reset"
      type="button"
      @click="clearAll"
      title="Сбросить фильтры"
    >
      <Icon name="x" :size="11" />
      <span>Сбросить</span>
    </button>

    <!--
      Deep-linked assignedOperatorId is shown as a removable chip so the
      operator can see why their inbox is filtered. There is no picker
      (Decision 5): adding one requires a role-safe operator-lookup
      endpoint, which is out of scope for this change.
    -->
    <Chip
      v-if="modelValue.assignedOperatorId"
      label="Оператор"
      :value="modelValue.assignedOperatorId"
      applied
      removable
      tone="violet"
      @remove="clearAssignedOperator"
    />
    </div>
  </div>
</template>

<style scoped>
.inbox-filters-wrap {
  border-bottom: 1px solid var(--line);
  background: var(--paper-2);
}
.filters-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
}
.filters-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.count-badge {
  min-width: 16px;
  height: 16px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.chev {
  transition: transform 0.15s ease;
}
.chev.open {
  transform: rotate(180deg);
}
.inbox-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 6px 8px;
  padding: 0 10px 8px;
}
.f-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.f-label {
  font-size: 10px;
  line-height: 1;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--ink-4);
}
.f-group .input {
  width: 100%;
}
.f-reset {
  align-self: flex-end;
}
</style>
