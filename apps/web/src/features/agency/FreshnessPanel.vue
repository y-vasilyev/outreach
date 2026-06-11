<script setup lang="ts">
import { computed } from 'vue';
import Icon from '../../components/Icon.vue';
import Pill from '../../components/Pill.vue';
import { freshnessAgeText, freshnessTone, freshnessTooltip } from './freshness-ui';
import type { ProfileFreshness, ProfileFreshnessCategory } from './types';

const props = defineProps<{ freshness: ProfileFreshness }>();

const SECTIONS: Array<{ key: ProfileFreshnessCategory; label: string }> = [
  { key: 'rateCards', label: 'Прайсы' },
  { key: 'audience', label: 'Аудитория' },
  { key: 'topics', label: 'Темы' },
  { key: 'languages', label: 'Языки' },
  { key: 'formats', label: 'Форматы' },
  { key: 'reach', label: 'Охват' },
  { key: 'avgViews', label: 'Ср. просмотры' },
];

// Tone/age/tooltip logic is shared with the inline metric badges — see
// freshness-ui.ts (decision-ux).
const tone = freshnessTone;
const ageText = freshnessAgeText;
const tooltip = freshnessTooltip;

const rows = computed(() => SECTIONS.map((s) => ({
  ...s,
  data: props.freshness[s.key],
})));
</script>

<template>
  <div class="card">
    <div class="card-head">
      <Icon name="clock" :size="12" />
      <span>Свежесть наблюдений</span>
      <span class="muted-2" style="margin-left: 6px;">возраст самого нового используемого наблюдения · TTL различается по секциям</span>
    </div>
    <div
      class="card-body"
      style="display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 8px;"
    >
      <div v-for="r in rows" :key="r.key" style="display: flex; flex-direction: column; gap: 4px; min-width: 0;">
        <div class="muted-2" style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;">{{ r.label }}</div>
        <Pill :cls="tone(r.data)" :title="tooltip(r.label, r.data)" :aria-label="tooltip(r.label, r.data)" style="align-self: flex-start;">
          <span class="mono">{{ ageText(r.data) }}</span>
        </Pill>
      </div>
    </div>
  </div>
</template>
