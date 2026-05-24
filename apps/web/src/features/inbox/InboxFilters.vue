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
];
const MODE_OPTIONS: Array<{ value: NonNullable<InboxFilters['mode']>; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'semi_auto', label: 'Semi-auto' },
  { value: 'assisted', label: 'Assisted' },
  { value: 'manual', label: 'Manual' },
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

function clearAll(): void {
  // `assignedOperatorId` is intentionally not cleared — see Decision 5
  // and task 5.3/5.4: a deep-link operator filter only goes away when
  // the operator explicitly removes its chip.
  emit('update:modelValue', {
    campaignId: undefined,
    status: undefined,
    mode: undefined,
    q: undefined,
  });
  localQ.value = '';
}

function clearAssignedOperator(): void {
  emit('update:modelValue', { assignedOperatorId: undefined });
}

const hasResettable = computed(
  () => Boolean(
    props.modelValue.campaignId
    || props.modelValue.status
    || props.modelValue.mode
    || props.modelValue.q,
  ),
);
</script>

<template>
  <div
    class="inbox-filters"
    style="display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--line); background: var(--paper-2);"
  >
    <select
      class="input sm"
      :value="modelValue.campaignId ?? ''"
      @change="setCampaign"
      style="max-width: 180px; flex: 1 1 140px;"
    >
      <option value="">Все кампании</option>
      <option v-for="c in campaignOptions" :key="c.id" :value="c.id">{{ c.name }}</option>
    </select>

    <select class="input sm" :value="modelValue.status ?? ''" @change="setStatus" style="max-width: 130px;">
      <option value="">Любой статус</option>
      <option v-for="o in STATUS_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
    </select>

    <select class="input sm" :value="modelValue.mode ?? ''" @change="setMode" style="max-width: 130px;">
      <option value="">Любой режим</option>
      <option v-for="o in MODE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
    </select>

    <input
      class="input sm"
      type="text"
      :value="localQ"
      @input="onQInput"
      placeholder="Поиск по контакту / каналу"
      maxlength="200"
      style="flex: 2 1 180px; min-width: 140px;"
    />

    <button
      v-if="hasResettable"
      class="btn ghost sm"
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
</template>
