<script setup lang="ts">
import { computed } from 'vue';
import Field from '../../components/Field.vue';
import TextareaInput from '../../components/TextareaInput.vue';
import MultiToggle from '../../components/MultiToggle.vue';

/**
 * Goal editor for the `agency_sourcing` campaign type. Drives the goal fields
 * declared by the type's goalSchema:
 *   - target_data_points: string[] (required) — the facts to collect
 *   - client_brief: string — context about who the agency represents
 *
 * v-model:targetDataPoints / v-model:clientBrief keep the CampaignForm the
 * single source of truth for the persisted `goal` object.
 */
const props = defineProps<{ targetDataPoints: string[]; clientBrief: string }>();
const emit = defineEmits<{
  (e: 'update:targetDataPoints', v: string[]): void;
  (e: 'update:clientBrief', v: string): void;
}>();

const TARGET_OPTIONS = [
  { value: 'rate_card', label: 'Прайс по форматам' },
  { value: 'reach', label: 'Охваты / просмотры' },
  { value: 'audience_demographics', label: 'Демография' },
  { value: 'geo', label: 'География' },
  { value: 'deals_contact', label: 'Контакт для сделок' },
];

function canonicalTargetDataPoint(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (v === 'rate_card' || v === 'rate' || v.startsWith('rate.')) return 'rate_card';
  if (v === 'reach' || v.startsWith('reach.') || v === 'views' || v.startsWith('views.')) {
    return 'reach';
  }
  if (
    v === 'audience_demographics' ||
    v === 'audience.age' ||
    v.startsWith('audience.age.') ||
    v === 'audience.gender' ||
    v.startsWith('audience.gender.')
  ) {
    return 'audience_demographics';
  }
  if (v === 'geo' || v === 'audience.geo' || v.startsWith('audience.geo.')) return 'geo';
  if (v === 'deals_contact' || v === 'contact' || v.startsWith('contact.')) return 'deals_contact';
  return null;
}

const selectedTargetDataPoints = computed(() => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of props.targetDataPoints ?? []) {
    const key = canonicalTargetDataPoint(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
});
</script>

<template>
  <div style="display: grid; grid-template-columns: 1fr; gap: 12px;">
    <Field
      label="Целевые точки данных (target_data_points)"
      help="Что нужно собрать у блогера. Сохраняется в campaign.goal.target_data_points canonical keys."
    >
      <MultiToggle
        :model-value="selectedTargetDataPoints"
        :options="TARGET_OPTIONS"
        tone="accent"
        @update:model-value="emit('update:targetDataPoints', $event)"
      />
    </Field>
    <Field label="Бриф клиента (client_brief)" help="Контекст: чьи интересы представляет агентство, какой продукт продвигается.">
      <TextareaInput
        :model-value="clientBrief"
        :rows="3"
        placeholder="Описание клиента/продукта, от лица которого ведётся сбор"
        @update:model-value="$emit('update:clientBrief', $event)"
      />
    </Field>
  </div>
</template>
