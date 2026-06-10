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
 * Settings → Атрибуты размещений (admin only). Review queue for LLM-proposed
 * placement attributes (entity-style-rate-cards): approve → joins the active
 * registry (planner starts chasing it), reject → closed. The collapsed
 * «История» section shows SUPERSEDED proposals (extraction-provenance) — a
 * re-run replaced them; they are audit context, never actionable.
 */

interface ReviewItem {
  id: string;
  key: string;
  valueType: string;
  description: string;
  applicableKinds: string[];
  enumValues: string[];
  status: 'active' | 'proposed' | 'rejected' | 'superseded';
  evidence: string[];
  confidence: number;
  rationale: string;
  sourceMessageId: string | null;
  proposedByRunId: string | null;
}

interface ReviewList {
  items: ReviewItem[];
  total: number;
  superseded?: ReviewItem[];
}

const qc = useQueryClient();
const showHistory = ref(false);

const { data, isLoading, isError } = useQuery({
  queryKey: ['placement-attribute-proposals'],
  queryFn: () =>
    api.get<ReviewList>('/placement-attributes/proposals?includeSuperseded=true'),
});

const proposals = computed<ReviewItem[]>(() => data.value?.items ?? []);
const history = computed<ReviewItem[]>(() => data.value?.superseded ?? []);

const reviewMut = useMutation({
  mutationFn: (vars: { id: string; decision: 'approve' | 'reject' }) =>
    api.post<ReviewItem>(`/placement-attributes/${vars.id}/review`, {
      decision: vars.decision,
    }),
  onSuccess: (_res, vars) => {
    qc.invalidateQueries({ queryKey: ['placement-attribute-proposals'] });
    toast.success(
      vars.decision === 'approve'
        ? 'Атрибут одобрен — планировщик начнёт его собирать'
        : 'Предложение отклонено',
    );
  },
  onError: (e: unknown) => {
    toast.error(e instanceof ApiError ? e.message : 'Не удалось обработать предложение');
  },
});
</script>

<template>
  <PageHead
    title="Атрибуты размещений"
    sub="Предложения новых коммерческих атрибутов от экстрактора. Одобрение добавляет ключ в активный реестр (агент начнёт уточнять его у блогеров). Доступно только администраторам."
  />

  <div v-if="isLoading" class="center"><Spinner /></div>

  <EmptyState
    v-else-if="isError"
    title="Не удалось загрузить предложения"
    description="Проверьте, что у вас роль администратора, и повторите."
    icon="shield"
  />

  <template v-else>
    <EmptyState
      v-if="proposals.length === 0"
      title="Очередь ревью пуста"
      description="Экстрактор пока не предлагал новых атрибутов — известные условия размещений уже покрыты активным реестром."
      icon="settings"
    />

    <div v-else class="cards" style="grid-template-columns: 1fr;">
      <div v-for="item in proposals" :key="item.id" class="card attr-card">
        <div class="attr-main">
          <div class="attr-text">
            <div class="attr-title">
              <span class="attr-key">{{ item.key }}</span>
              <Pill cls="ghost" :label="item.valueType" />
              <Pill cls="ok" :label="`${Math.round(item.confidence * 100)}%`" />
            </div>
            <div v-if="item.rationale" class="attr-desc">{{ item.rationale }}</div>
            <div v-if="item.applicableKinds.length" class="attr-meta">
              форматы: {{ item.applicableKinds.join(', ') }}
              <span v-if="item.enumValues.length"> · значения: {{ item.enumValues.join(' | ') }}</span>
            </div>
            <div v-for="(ev, i) in item.evidence.slice(0, 2)" :key="i" class="attr-evidence">
              «{{ ev }}»
            </div>
          </div>
          <div class="attr-actions">
            <button
              class="btn primary"
              :disabled="reviewMut.isPending.value"
              @click="reviewMut.mutate({ id: item.id, decision: 'approve' })"
            >
              Одобрить
            </button>
            <button
              class="btn danger"
              :disabled="reviewMut.isPending.value"
              @click="reviewMut.mutate({ id: item.id, decision: 'reject' })"
            >
              Отклонить
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Superseded history (extraction-provenance): collapsed, non-actionable. -->
    <div v-if="history.length" class="card" style="margin-top: 16px; padding: 12px 16px;">
      <button class="history-toggle" @click="showHistory = !showHistory">
        {{ showHistory ? '▾' : '▸' }} История: заменённые переразбором ({{ history.length }})
      </button>
      <div v-if="showHistory" style="margin-top: 10px; display: flex; flex-direction: column; gap: 8px;">
        <div v-for="item in history" :key="item.id" class="history-row">
          <span class="attr-key">{{ item.key }}</span>
          <Pill cls="ghost" label="заменено" />
          <span v-if="item.evidence[0]" class="attr-evidence">«{{ item.evidence[0] }}»</span>
        </div>
      </div>
    </div>
  </template>
</template>

<style scoped>
.attr-card {
  padding: 16px;
}
.attr-main {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.attr-text {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.attr-title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.attr-key {
  font-family: var(--mono, monospace);
  font-weight: 600;
}
.attr-desc {
  color: var(--text-muted, #888);
  font-size: 13px;
}
.attr-meta {
  font-size: 12px;
  color: var(--text-muted, #888);
}
.attr-evidence {
  font-size: 12px;
  font-style: italic;
  color: var(--text-muted, #888);
}
.attr-actions {
  display: flex;
  gap: 8px;
}
.history-toggle {
  background: none;
  border: none;
  color: var(--text-muted, #888);
  cursor: pointer;
  font-size: 13px;
  padding: 0;
}
.history-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
