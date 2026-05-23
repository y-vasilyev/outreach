<script setup lang="ts">
import Field from '../../components/Field.vue';
import TextareaInput from '../../components/TextareaInput.vue';
import TagInput from '../../components/TagInput.vue';

/**
 * Goal editor for the `agency_sourcing` campaign type. Drives the goal fields
 * declared by the type's goalSchema:
 *   - target_data_points: string[] (required) — the facts to collect
 *   - client_brief: string — context about who the agency represents
 *
 * v-model:targetDataPoints / v-model:clientBrief keep the CampaignForm the
 * single source of truth for the persisted `goal` object.
 */
defineProps<{ targetDataPoints: string[]; clientBrief: string }>();
defineEmits<{
  (e: 'update:targetDataPoints', v: string[]): void;
  (e: 'update:clientBrief', v: string): void;
}>();
</script>

<template>
  <div style="display: grid; grid-template-columns: 1fr; gap: 12px;">
    <Field
      label="Целевые точки данных (target_data_points)"
      help="Что нужно собрать у блогера: прайс, форматы, охваты, статистика аудитории, сроки. Enter — добавить."
    >
      <TagInput
        :model-value="targetDataPoints"
        placeholder="например: rate.post и Enter"
        @update:model-value="$emit('update:targetDataPoints', $event)"
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
