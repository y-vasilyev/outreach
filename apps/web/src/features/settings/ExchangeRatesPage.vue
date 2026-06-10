<script setup lang="ts">
import { computed, ref } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import PageHead from '../../components/PageHead.vue';
import Pill from '../../components/Pill.vue';
import Spinner from '../../components/Spinner.vue';
import EmptyState from '../../components/EmptyState.vue';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../lib/toast';

/**
 * Settings → Курсы валют (admin only, price-normalization-v2). The CURRENT
 * rate per currency for offer normalization: while a currency has no rate,
 * its offers stay visible but unnormalized (excluded from ₽-comparisons).
 * Saving a rate triggers renormalization of active offers in that currency.
 */

interface ExchangeRateRow {
  currency: string;
  rateToRub: number;
  asOf: string;
  source: string;
  updatedById: string | null;
  updatedAt: string;
}

const qc = useQueryClient();

const { data, isLoading, isError } = useQuery({
  queryKey: ['exchange-rates'],
  queryFn: () => api.get<ExchangeRateRow[]>('/settings/exchange-rates'),
});
const list = computed<ExchangeRateRow[]>(() => data.value ?? []);

const formCurrency = ref('');
const formRate = ref('');

const saveMut = useMutation({
  mutationFn: (vars: { currency: string; rateToRub: number }) =>
    api.put<ExchangeRateRow>(`/settings/exchange-rates/${vars.currency}`, {
      rateToRub: vars.rateToRub,
    }),
  onSuccess: (res) => {
    qc.invalidateQueries({ queryKey: ['exchange-rates'] });
    toast.success(`Курс ${res.currency} сохранён; офферы пересчитываются`);
    formCurrency.value = '';
    formRate.value = '';
  },
  onError: (e: unknown) => {
    toast.error(e instanceof ApiError ? e.message : 'Не удалось сохранить курс');
  },
});

const removeMut = useMutation({
  mutationFn: (currency: string) => api.del(`/settings/exchange-rates/${currency}`),
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: ['exchange-rates'] });
    toast.success('Курс удалён; офферы в этой валюте остаются без ₽-нормализации');
  },
  onError: (e: unknown) => {
    toast.error(e instanceof ApiError ? e.message : 'Не удалось удалить курс');
  },
});

function submit(): void {
  const currency = formCurrency.value.trim().toUpperCase();
  const rate = Number(formRate.value.replace(',', '.'));
  if (!/^[A-Z]{3}$/.test(currency) || currency === 'RUB') {
    toast.error('Код валюты — три латинские буквы (USD, EUR), не RUB');
    return;
  }
  if (!Number.isFinite(rate) || rate <= 0) {
    toast.error('Курс — положительное число (рублей за единицу валюты)');
    return;
  }
  saveMut.mutate({ currency, rateToRub: rate });
}

function startEdit(row: ExchangeRateRow): void {
  formCurrency.value = row.currency;
  formRate.value = String(row.rateToRub);
}

const DAY_MS = 24 * 60 * 60 * 1000;
function ageDays(iso: string): number {
  return Math.floor((Date.now() - Date.parse(iso)) / DAY_MS);
}
</script>

<template>
  <PageHead
    title="Курсы валют"
    sub="Текущий курс к рублю для нормализации прайсов блогеров. Пока курс не задан, офферы в этой валюте видны, но не участвуют в ₽-сравнениях. Доступно только администраторам."
  />

  <div class="card rate-form">
    <input
      v-model="formCurrency"
      class="input"
      placeholder="Валюта (USD)"
      maxlength="3"
      style="width: 120px; text-transform: uppercase;"
    />
    <input
      v-model="formRate"
      class="input"
      placeholder="₽ за единицу (92.4)"
      inputmode="decimal"
      style="width: 180px;"
    />
    <button class="btn primary" :disabled="saveMut.isPending.value" @click="submit">
      Сохранить курс
    </button>
  </div>

  <div v-if="isLoading" class="center"><Spinner /></div>

  <EmptyState
    v-else-if="isError"
    title="Не удалось загрузить курсы"
    description="Проверьте, что у вас роль администратора, и повторите."
    icon="shield"
  />

  <EmptyState
    v-else-if="list.length === 0"
    title="Курсы не заданы"
    description="Задайте курс USD и EUR выше, чтобы долларовые и евровые прайсы блогеров участвовали в сравнении и подборе в рублях."
    icon="settings"
  />

  <div v-else class="cards" style="grid-template-columns: 1fr;">
    <div v-for="row in list" :key="row.currency" class="card rate-card">
      <div class="rate-main">
        <div class="rate-text">
          <div class="rate-title">
            <span class="rate-code">{{ row.currency }}</span>
            <span class="rate-value">{{ row.rateToRub }} ₽</span>
            <Pill
              :cls="ageDays(row.asOf) > 30 ? 'warn' : 'ok'"
              :label="`от ${row.asOf.slice(0, 10)}`"
            />
          </div>
          <div class="rate-desc">
            Обновлён {{ row.updatedAt.slice(0, 10) }} ({{ row.source }})
            <span v-if="ageDays(row.asOf) > 30"> — курс старше месяца, проверьте актуальность</span>
          </div>
        </div>
        <div class="rate-actions">
          <button class="btn" @click="startEdit(row)">Изменить</button>
          <button
            class="btn danger"
            :disabled="removeMut.isPending.value"
            @click="removeMut.mutate(row.currency)"
          >
            Удалить
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rate-form {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 12px 16px;
  margin-bottom: 16px;
}
.rate-card {
  padding: 16px;
}
.rate-main {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.rate-text {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.rate-title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rate-code {
  font-family: var(--mono, monospace);
  font-weight: 600;
}
.rate-value {
  font-weight: 600;
}
.rate-desc {
  color: var(--text-muted, #888);
  font-size: 13px;
}
.rate-actions {
  display: flex;
  gap: 8px;
}
</style>
