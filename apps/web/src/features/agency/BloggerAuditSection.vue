<script setup lang="ts">
import { computed, ref } from 'vue';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import ConfBar from '../../components/ConfBar.vue';
import Icon from '../../components/Icon.vue';
import FreshnessPanel from './FreshnessPanel.vue';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { toast } from '../../lib/toast';
import type { BloggerProfile, ProfileDataPoint } from './types';

// Аудит-секция (decision-ux): провенанс, операторские правки, extraction
// hints, полная таблица свежести и внутренние идентификаторы. Свёрнута по
// умолчанию — это работа «проверить экстракцию», а не «выбрать блогера».
const props = defineProps<{ profile: BloggerProfile }>();

const qc = useQueryClient();
const dataPoints = computed<ProfileDataPoint[]>(() => props.profile.dataPoints ?? []);

function renderValue(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

async function copyChannelId(): Promise<void> {
  const id = props.profile.channelId;
  if (!id) return;
  try {
    await navigator.clipboard.writeText(id);
    toast.success('ID канала скопирован');
  } catch {
    toast.error('Не удалось скопировать');
  }
}

// Operator corrections (operator-reanalyze-and-markup): delete a wrong machine
// point; write an operator-origin value that the roll-up prefers.
const deleteDpMut = useMutation({
  mutationFn: (dpId: string) => api.del(`/blogger-profiles/${props.profile.id}/data-points/${dpId}`),
  onSuccess: () => {
    toast.success('Точка данных удалена; профиль пересчитан');
    qc.invalidateQueries({ queryKey: ['blogger-profile'] });
  },
  onError: (e) => toast.error('Не удалось удалить', (e as Error).message),
});
const writeForm = ref<{ field: string; value: string }>({ field: '', value: '' });
const writeDpMut = useMutation({
  mutationFn: (body: { field: string; value: unknown }) =>
    api.post(`/blogger-profiles/${props.profile.id}/data-points`, body),
  onSuccess: () => {
    toast.success('Операторская правка сохранена');
    writeForm.value = { field: '', value: '' };
    qc.invalidateQueries({ queryKey: ['blogger-profile'] });
  },
  onError: (e) => toast.error('Не удалось сохранить', (e as Error).message),
});
function submitWrite(): void {
  const field = writeForm.value.field.trim();
  if (!field) return;
  const raw = writeForm.value.value.trim();
  const num = Number(raw.replace(/[\s,]/g, ''));
  writeDpMut.mutate({ field, value: Number.isFinite(num) && raw !== '' ? num : raw });
}

// Extraction hint (operator-reanalyze-and-markup): teach the agents a nuance for
// this blogger's channel that the next analysis honors.
const hintText = ref('');
const hintMut = useMutation({
  mutationFn: (guidance: string) =>
    api.post('/extraction-hints', {
      scope: props.profile.channelId ? 'channel' : 'global',
      channelId: props.profile.channelId ?? null,
      guidance,
    }),
  onSuccess: () => {
    toast.success('Подсказка сохранена; агенты учтут её при следующем анализе');
    hintText.value = '';
  },
  onError: (e) => toast.error('Не удалось сохранить подсказку', (e as Error).message),
});
function submitHint(): void {
  const g = hintText.value.trim();
  if (g) hintMut.mutate(g);
}
</script>

<template>
  <details class="card">
    <summary class="card-head" style="cursor: pointer; list-style: revert;">
      <Icon name="list" :size="12" /><span>Аудит данных ({{ dataPoints.length }})</span>
      <span class="muted-2" style="margin-left: 6px;">провенанс, свежесть, правки оператора, идентификаторы</span>
    </summary>
    <div class="card-body" style="display: flex; flex-direction: column; gap: 12px;">
      <!-- Per-section observation freshness (full table; inline badges on the
           metric tiles are the day-to-day view). -->
      <FreshnessPanel v-if="profile.freshness" :freshness="profile.freshness" />

      <!-- Internal identifiers & observation timestamps. -->
      <div style="display: flex; flex-direction: column; gap: 4px; font-size: 12px;">
        <div style="display: flex; gap: 8px; align-items: center;">
          <span class="muted-2" style="min-width: 130px;">Канал (внутр. ID)</span>
          <span class="mono">{{ profile.channelId ?? '—' }}</span>
          <button
            v-if="profile.channelId"
            type="button"
            class="btn ghost icon-only sm"
            title="Скопировать ID канала"
            @click="copyChannelId"
          ><Icon name="copy" :size="11" /></button>
        </div>
        <div style="display: flex; gap: 8px;">
          <span class="muted-2" style="min-width: 130px;">Снято (captured)</span>
          <span>{{ profile.capturedAt ? formatDateTime(profile.capturedAt) : '—' }}</span>
        </div>
        <div style="display: flex; gap: 8px;">
          <span class="muted-2" style="min-width: 130px;">Обновлён</span>
          <span>{{ formatDateTime(profile.updatedAt) }}</span>
        </div>
      </div>

      <!-- Data points with provenance -->
      <div>
        <div class="muted-2" style="font-size: 11px; text-transform: uppercase; margin-bottom: 6px;">
          Точки данных ({{ dataPoints.length }})
        </div>
        <div v-if="!dataPoints.length" class="placeholder" style="min-height: 48px;">Точек данных нет.</div>
        <table v-else class="tbl">
          <thead>
            <tr>
              <th>Поле</th><th>Значение</th><th>Уверенность</th><th>Источник (raw)</th><th>Снято</th><th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="dp in dataPoints" :key="dp.id">
              <td class="mono" style="font-size: 12px;">
                {{ dp.field }}
                <span v-if="dp.extractedBy === 'operator'" class="mono" style="font-size: 9.5px; color: var(--accent-2);" title="Правка оператора">✎</span>
              </td>
              <td>
                <span class="cell-strong">{{ renderValue(dp.value) }}</span>
                <span v-if="dp.unit" class="muted-2"> {{ dp.unit }}</span>
              </td>
              <td style="min-width: 90px;">
                <div style="display: flex; align-items: center; gap: 6px;">
                  <ConfBar :value="dp.confidence" />
                  <span class="mono" style="font-size: 11px;">{{ Math.round(dp.confidence * 100) }}%</span>
                </div>
              </td>
              <td>
                <span class="muted-2" style="font-size: 11.5px; font-style: italic;">{{ dp.rawSnippet || '—' }}</span>
              </td>
              <td><span class="muted-2" style="font-size: 11px;">{{ formatDateTime(dp.capturedAt) }}</span></td>
              <td style="text-align: right;">
                <button
                  type="button"
                  class="btn-icon"
                  title="Удалить точку данных"
                  :disabled="deleteDpMut.isPending.value"
                  style="background: none; border: none; cursor: pointer; color: var(--ink-4);"
                  @click="deleteDpMut.mutate(dp.id)"
                ><Icon name="trash" :size="12" /></button>
              </td>
            </tr>
          </tbody>
        </table>
        <!-- Operator correction: add an operator-origin value the roll-up prefers
             (operator-reanalyze-and-markup). Field-aware validation is server-side. -->
        <form
          style="display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap;"
          @submit.prevent="submitWrite"
        >
          <input
            v-model="writeForm.field"
            class="input mono"
            style="font-size: 11.5px; width: 200px;"
            placeholder="поле (напр. reach, rate.post)"
          />
          <input
            v-model="writeForm.value"
            class="input"
            style="font-size: 11.5px; width: 160px;"
            placeholder="значение"
          />
          <button class="btn" type="submit" :disabled="writeDpMut.isPending.value || !writeForm.field.trim()">
            <Icon name="plus" :size="11" /><span>Добавить правку</span>
          </button>
        </form>
        <!-- Extraction hint: teach the agents this blogger's nuance for next time. -->
        <form
          style="display: flex; gap: 8px; align-items: center; margin-top: 8px; flex-wrap: wrap;"
          @submit.prevent="submitHint"
        >
          <input
            v-model="hintText"
            class="input"
            style="font-size: 11.5px; flex: 1; min-width: 240px;"
            placeholder="Подсказка агенту (напр. «МАХ — это мессенджер MAX, площадка max»)"
          />
          <button class="btn" type="submit" :disabled="hintMut.isPending.value || !hintText.trim()">
            <Icon name="spark" :size="11" /><span>Сохранить подсказку</span>
          </button>
        </form>
      </div>
    </div>
  </details>
</template>
