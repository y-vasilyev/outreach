<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import Icon from './Icon.vue';
import { api, ApiError } from '../lib/api';

export interface ModelOption {
  id: string;
  name?: string;
  description?: string;
  contextLength?: number;
  pricing?: { promptPer1M?: number; completionPer1M?: number };
}

const props = defineProps<{
  endpointId: string | null | undefined;
  modelValue: string;
  label?: string;
  help?: string;
}>();

const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();

const query = ref('');
const open = ref(false);
// `field` is the wrapper used for click-outside checks; `inputEl` is the
// anchor we measure to position the floating menu.
const field = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);
const menuPos = ref<{ top: number; left: number; width: number; placeAbove: boolean }>({
  top: 0,
  left: 0,
  width: 0,
  placeAbove: false,
});

const endpointEnabled = computed(() => !!props.endpointId);

const { data: models, isLoading, isError, error, refetch } = useQuery({
  queryKey: ['endpoint-models', () => props.endpointId],
  queryFn: () => api.get<ModelOption[]>(`/endpoints/${props.endpointId}/models`),
  enabled: endpointEnabled,
  staleTime: 5 * 60_000,
  retry: false,
});

const filtered = computed<ModelOption[]>(() => {
  const list = models.value ?? [];
  const q = query.value.trim().toLowerCase();
  if (!q) return list.slice(0, 200);
  return list
    .filter((m) => `${m.id} ${m.name ?? ''} ${m.description ?? ''}`.toLowerCase().includes(q))
    .slice(0, 200);
});

const allowFreeform = computed(
  () => query.value.length > 0 && !filtered.value.some((m) => m.id === query.value),
);

const errMsg = computed(() => {
  if (!isError.value) return null;
  const e = error.value;
  if (e instanceof ApiError) return `${e.code}: ${e.message}`;
  return (e as Error)?.message ?? null;
});

function pick(id: string): void {
  emit('update:modelValue', id);
  open.value = false;
  query.value = '';
}

watch(
  () => props.modelValue,
  (v) => {
    if (!open.value) query.value = v ?? '';
  },
  { immediate: true },
);

/**
 * Position the floating menu against the input element. Uses fixed
 * positioning so we escape any `overflow: hidden` ancestor (notably
 * `.card`, which clips with rounded corners). When there isn't enough
 * room below, flip the menu upward — common in long config forms where
 * the input may be near the bottom of the viewport.
 */
function recomputePosition(): void {
  const el = inputEl.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const menuMaxHeight = 320;
  const spaceBelow = window.innerHeight - rect.bottom;
  const placeAbove = spaceBelow < menuMaxHeight && rect.top > spaceBelow;
  menuPos.value = {
    top: placeAbove ? rect.top : rect.bottom,
    left: rect.left,
    width: rect.width,
    placeAbove,
  };
}

watch(open, (v) => {
  if (v) {
    // Defer one frame so layout has settled if we just opened on focus.
    requestAnimationFrame(recomputePosition);
  }
});

function onScrollOrResize(): void {
  if (open.value) recomputePosition();
}

function onClickOutside(e: MouseEvent): void {
  const target = e.target as Node;
  if (field.value?.contains(target)) return;
  // Allow clicks INSIDE the teleported menu (it lives outside `field`).
  if ((target as HTMLElement)?.closest?.('[data-model-combobox-menu]')) return;
  open.value = false;
}

onMounted(() => {
  document.addEventListener('mousedown', onClickOutside);
  window.addEventListener('scroll', onScrollOrResize, true);
  window.addEventListener('resize', onScrollOrResize);
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onClickOutside);
  window.removeEventListener('scroll', onScrollOrResize, true);
  window.removeEventListener('resize', onScrollOrResize);
});

function fmtCtx(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

const menuStyle = computed(() => ({
  position: 'fixed' as const,
  top: menuPos.value.placeAbove ? `${menuPos.value.top}px` : `${menuPos.value.top + 4}px`,
  left: `${menuPos.value.left}px`,
  width: `${menuPos.value.width}px`,
  maxHeight: '320px',
  overflow: 'auto',
  padding: '4px',
  // Above modals (z-index 100); the field stays in document flow.
  zIndex: 200,
  ...(menuPos.value.placeAbove ? { transform: 'translateY(-100%)', marginBottom: '4px' } : {}),
}));
</script>

<template>
  <div class="field-row" ref="field">
    <label v-if="label" class="field-label">{{ label }}</label>
    <div style="position: relative;">
      <input
        ref="inputEl"
        :class="['input', !endpointEnabled ? '' : '']"
        :value="open ? query : modelValue"
        :placeholder="endpointEnabled ? 'Поиск модели…' : 'Сначала выберите endpoint'"
        :disabled="!endpointEnabled"
        @input="(e) => { query = (e.target as HTMLInputElement).value; open = true; }"
        @focus="() => { open = true; query = modelValue; }"
        autocomplete="off"
      />
      <button
        type="button"
        class="btn ghost icon-only sm"
        style="position: absolute; right: 2px; top: 50%; transform: translateY(-50%);"
        :disabled="!endpointEnabled"
        @click="open = !open"
      >
        <Icon name="chev_up_down" :size="12" />
      </button>
    </div>
    <div v-if="help" class="field-help">{{ help }}</div>
  </div>

  <Teleport to="body">
    <div
      v-if="open"
      class="dropdown-menu"
      data-model-combobox-menu
      :style="menuStyle"
    >
      <div v-if="isLoading" style="padding: 8px 10px; font-size: 11px; color: var(--ink-3);">
        Загрузка моделей…
      </div>
      <div v-else-if="isError" style="padding: 8px 10px; font-size: 11px; color: var(--bad);">
        <div style="display: inline-flex; align-items: center; gap: 4px;">
          <Icon name="warn" :size="12" />
          <span>{{ errMsg ?? 'Не удалось получить список моделей' }}</span>
        </div>
        <button type="button" class="btn ghost sm" style="margin-top: 4px;" @click="refetch()">
          Повторить
        </button>
      </div>
      <button v-if="allowFreeform" type="button" class="dropdown-item" @click="pick(query)">
        Использовать как есть: <code class="mono">{{ query }}</code>
      </button>
      <button
        v-for="m in filtered"
        :key="m.id"
        type="button"
        class="dropdown-item"
        @click="pick(m.id)"
      >
        <div style="display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1;">
          <div class="mono ellipsis" style="font-size: 11.5px;">{{ m.id }}</div>
          <div v-if="m.name && m.name !== m.id" class="muted-2 ellipsis" style="font-size: 10.5px;">
            {{ m.name }}
          </div>
          <div
            v-if="m.contextLength != null || m.pricing"
            class="muted-2"
            style="font-size: 10px; display: flex; gap: 8px; flex-wrap: wrap;"
          >
            <span v-if="m.contextLength != null">ctx {{ fmtCtx(m.contextLength) }}</span>
            <span v-if="m.pricing?.promptPer1M != null">
              ${{ m.pricing.promptPer1M.toFixed(2) }}/1M in
            </span>
            <span v-if="m.pricing?.completionPer1M != null">
              ${{ m.pricing.completionPer1M.toFixed(2) }}/1M out
            </span>
          </div>
        </div>
      </button>
      <div
        v-if="!isLoading && !isError && filtered.length === 0 && !allowFreeform"
        style="padding: 8px 10px; font-size: 11px; color: var(--ink-3);"
      >
        Ничего не найдено
      </div>
    </div>
  </Teleport>
</template>
