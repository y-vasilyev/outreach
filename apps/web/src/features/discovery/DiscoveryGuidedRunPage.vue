<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import PageHead from '../../components/PageHead.vue';
import Icon from '../../components/Icon.vue';
import Spinner from '../../components/Spinner.vue';
import Pill from '../../components/Pill.vue';
import EmptyState from '../../components/EmptyState.vue';
import FeatureOff from '../../components/FeatureOff.vue';
import SelectInput from '../../components/SelectInput.vue';
import Modal from '../../components/Modal.vue';
import { api, ApiError } from '../../lib/api';
import { isFeatureOff } from '../../lib/featureGate';
import { toast } from '../../lib/toast';
import { formatDateTime, formatNumber } from '../../lib/format';
import {
  guidedPollInterval,
  guidedStatusPill,
  recommendationPill,
  recommendationLabel,
  enrichmentPill,
  scoreLabel,
} from './helpers';
import type {
  CandidateActionKind,
  CandidateLaunchResult,
  DiscoveryCampaignOption,
  GuidedRunCandidate,
  GuidedRunDetail,
} from './types';

const route = useRoute();
const router = useRouter();
const qc = useQueryClient();
const id = computed(() => route.params.id as string);

const { data, isLoading, error } = useQuery({
  queryKey: ['discovery-guided', id],
  queryFn: () => api.get<GuidedRunDetail>(`/discovery/guided/${id.value}`),
  enabled: computed(() => !!id.value),
  refetchInterval: (q) =>
    guidedPollInterval(q.state.data as GuidedRunDetail | undefined, q.state.error),
  retry: false,
});

const featureOff = computed(() => isFeatureOff(error.value));
const notFound = computed(
  () => error.value instanceof ApiError && error.value.status === 404 && error.value.code === 'NOT_FOUND',
);
const stillRunning = computed(
  () => data.value != null && data.value.status !== 'done' && data.value.status !== 'failed',
);

// Candidates sorted: recommendation strength then score.
const RANK: Record<string, number> = { strong_fit: 3, possible_fit: 2, weak_fit: 1, reject: 0 };
const candidatesSorted = computed<GuidedRunCandidate[]>(() => {
  const items = data.value?.candidates ?? [];
  return [...items].sort((a, b) => {
    const ra = a.recommendation ? RANK[a.recommendation] ?? -1 : -1;
    const rb = b.recommendation ? RANK[b.recommendation] ?? -1 : -1;
    if (rb !== ra) return rb - ra;
    return (b.score ?? -1) - (a.score ?? -1);
  });
});

// Expanded candidate evidence panels.
const expanded = ref<Set<string>>(new Set());
function toggle(cid: string): void {
  const next = new Set(expanded.value);
  if (next.has(cid)) next.delete(cid);
  else next.add(cid);
  expanded.value = next;
}

const actionMut = useMutation({
  mutationFn: (vars: { candidateId: string; action: CandidateActionKind }) =>
    api.post<{ ok: true }>(
      `/discovery/guided/${id.value}/candidates/${vars.candidateId}/action`,
      { action: vars.action },
    ),
  onSuccess: (_r, vars) => {
    qc.invalidateQueries({ queryKey: ['discovery-guided', id] });
    toast.success(
      vars.action === 'scrape_refresh' ? 'Scrape поставлен в очередь — будет переразбор' : 'Сохранено',
    );
  },
  onError: (e: Error) => toast.error('Действие не удалось', e.message),
});

function act(candidateId: string, action: CandidateActionKind): void {
  if (actionMut.isPending.value || launchMut.isPending.value) return;
  actionMut.mutate({ candidateId, action });
}

// ─── launch-into-work bridge ───
// Puts a chosen blogger's business/ad contacts into a campaign and prepares a
// PENDING opener for operator approval (never auto-sends — human-approval gate).
// Campaign options are best-effort; if none load, the run's own campaign is used
// (the launch service resolves `campaignId ?? run.campaignId`).
const { data: campaigns } = useQuery({
  queryKey: ['discovery-campaign-options'],
  queryFn: () => api.get<DiscoveryCampaignOption[]>('/campaigns'),
  enabled: computed(() => !!data.value),
  retry: false,
});

const launchFor = ref<GuidedRunCandidate | null>(null);
const launchCampaignId = ref<string>('');

function openLaunch(c: GuidedRunCandidate): void {
  launchFor.value = c;
  launchCampaignId.value = data.value?.campaignId ?? '';
}
function closeLaunch(): void {
  launchFor.value = null;
  launchCampaignId.value = '';
}

// Launch needs a campaign: either the operator picks one or the run already has
// one bound. Without either, the service would 400 — guard the confirm button.
const launchResolvedCampaignId = computed(
  () => launchCampaignId.value || data.value?.campaignId || '',
);
const canLaunch = computed(() => launchResolvedCampaignId.value.length > 0);

const launchMut = useMutation({
  mutationFn: (vars: { candidateId: string; campaignId: string }) =>
    api.post<CandidateLaunchResult>(
      `/discovery/guided/${id.value}/candidates/${vars.candidateId}/action`,
      { action: 'launch', campaignId: vars.campaignId },
    ),
  onSuccess: (r) => {
    qc.invalidateQueries({ queryKey: ['discovery-guided', id] });
    closeLaunch();
    if (r.blocker) {
      toast.error(
        'Запущено, но есть блокер',
        r.blocker === 'no_accounts'
          ? 'Нет TG-аккаунтов для отправки'
          : 'Нет активных TG-аккаунтов',
      );
    } else {
      toast.success(
        'Запущено в работу',
        `чатов: ${r.chatsCreated} · черновиков на подтверждение: ${r.suggestionsQueued}`,
      );
    }
  },
  onError: (e: Error) => toast.error('Не удалось запустить в работу', e.message),
});

function confirmLaunch(): void {
  const c = launchFor.value;
  if (!c || !canLaunch.value || launchMut.isPending.value) return;
  launchMut.mutate({ candidateId: c.id, campaignId: launchResolvedCampaignId.value });
}

const campaignOpts = computed(() => [
  { value: '', label: data.value?.campaignId ? 'Кампания запуска (по умолчанию)' : '— выберите кампанию —' },
  ...(campaigns.value ?? []).map((c) => ({ value: c.id, label: c.name })),
]);

function openChannel(): void {
  router.push('/channels');
}
function openProfile(profileId: string): void {
  router.push(`/bloggers/${profileId}`);
}

function decisionPill(d: GuidedRunCandidate['decision']): 'ghost' | 'ok' | 'accent' | 'bad' {
  if (d === 'saved') return 'ok';
  if (d === 'shortlisted') return 'accent';
  if (d === 'launched') return 'accent';
  if (d === 'rejected') return 'bad';
  return 'ghost';
}

function decisionLabel(d: GuidedRunCandidate['decision']): string {
  if (d === 'saved') return 'сохранён';
  if (d === 'shortlisted') return 'в шортлисте';
  if (d === 'launched') return 'в работе';
  if (d === 'rejected') return 'отклонён';
  return '—';
}

/** Launch is offered only for saved/shortlisted candidates with a linked channel. */
function canOfferLaunch(c: GuidedRunCandidate): boolean {
  return !!c.channelId && (c.decision === 'saved' || c.decision === 'shortlisted');
}
</script>

<template>
  <PageHead :title="`Guided run · ${id.slice(0, 8)}…`" sub="План запросов, лог, кандидаты и рекомендации">
    <template #actions>
      <button class="btn" @click="router.push('/discovery')">
        <Icon name="arrow_left" :size="12" /><span>К Discovery</span>
      </button>
    </template>
  </PageHead>

  <FeatureOff v-if="featureOff" flag="channel_discovery" />

  <EmptyState
    v-else-if="notFound"
    title="Запуск не найден"
    description="Запуск с таким id не существует или был удалён."
    icon="search"
  >
    <template #action>
      <button class="btn" @click="router.push('/discovery')"><Icon name="arrow_left" :size="12" /><span>К Discovery</span></button>
    </template>
  </EmptyState>

  <EmptyState
    v-else-if="error"
    title="Ошибка загрузки запуска"
    :description="error instanceof ApiError ? error.message : 'Неизвестная ошибка'"
    icon="warn"
  />

  <div v-else-if="isLoading || !data" class="center"><Spinner /></div>

  <div v-else class="cards" style="grid-template-columns: 1fr;">
    <!-- Header: status, timing, summary counts -->
    <div class="card">
      <div class="card-body" style="display: flex; flex-direction: column; gap: 10px;">
        <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
          <Pill :cls="guidedStatusPill(data.status)">{{ data.status }}</Pill>
          <span class="muted-2" style="font-size: 12px;">создан</span>
          <span class="mono" style="font-size: 12px;">{{ formatDateTime(data.createdAt) }}</span>
          <span v-if="data.completedAt" class="muted-2" style="font-size: 12px;">· завершён</span>
          <span v-if="data.completedAt" class="mono" style="font-size: 12px;">{{ formatDateTime(data.completedAt) }}</span>
          <span class="muted-2" style="font-size: 12px;">· платформа</span>
          <span class="mono" style="font-size: 12px;">{{ data.input.platform ?? 'all' }}</span>
          <span v-if="stillRunning" class="muted-2" style="font-size: 11px; margin-left: 4px;"><span class="spinner" /> обновляется</span>
        </div>

        <div v-if="data.input.brief" class="muted" style="font-size: 12.5px;">{{ data.input.brief }}</div>

        <div style="display: grid; grid-template-columns: repeat(7, 1fr); gap: 8px;">
          <div v-for="t in [
            { l: 'Запросов', v: data.summary.plannedQueries, accent: false },
            { l: 'Выполнено', v: data.summary.executedQueries, accent: false },
            { l: 'Найдено', v: data.summary.candidatesFound, accent: false },
            { l: 'Разобрано', v: data.summary.candidatesReviewed, accent: false },
            { l: 'Ожидают разбора', v: data.summary.pendingReview, accent: data.summary.pendingReview > 0 },
            { l: 'Рекоменд.', v: data.summary.recommended, accent: false },
            { l: 'Ошибок', v: data.summary.failedQueries, accent: false },
          ]" :key="t.l">
            <div class="muted-2" style="font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em;">{{ t.l }}</div>
            <div
              style="font-size: 17px; font-weight: 600; font-family: var(--font-mono);"
              :style="{ color: t.accent ? 'var(--accent)' : undefined }"
              :data-test="t.l === 'Ожидают разбора' ? 'pending-review' : undefined"
            >{{ formatNumber(t.v) }}</div>
          </div>
        </div>

        <div v-if="data.status === 'enriching'" class="muted-2" style="font-size: 11.5px; color: var(--accent);">
          <span class="spinner" /> Идёт разбор по мере поступления данных скрейпа · ожидают разбора: {{ formatNumber(data.summary.pendingReview) }}
        </div>

        <div class="muted-2" style="font-size: 11px;">
          Бюджет: запросов ≤ {{ data.summary.budgets.maxQueries }} · результатов/запрос ≤ {{ data.summary.budgets.maxResultsPerQuery }} · кандидатов ≤ {{ data.summary.budgets.maxCandidates }} · разбор ≤ {{ data.summary.budgets.maxReviewed }}
          <span v-if="data.summary.candidatesSkipped > 0"> · пропущено {{ data.summary.candidatesSkipped }} (лимит разбора)</span>
        </div>

        <div v-if="data.summary.fatalError" class="card" style="background: var(--bad-bg); border-color: var(--bad-line); padding: 10px 12px;">
          <div style="font-size: 12px; color: var(--bad);"><Icon name="warn" :size="12" /> Fatal: {{ data.summary.fatalError }}</div>
        </div>
      </div>
    </div>

    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
      <!-- Planned queries -->
      <div class="card">
        <div class="card-head"><Icon name="search" :size="12" /><span>План запросов ({{ data.plannedQueries.length }})</span></div>
        <div class="card-body">
          <div v-if="!data.plannedQueries.length" class="placeholder" style="min-height: 40px;">Планировщик ещё не отработал.</div>
          <table v-else class="tbl">
            <thead><tr><th>Запрос</th><th>Платф.</th><th class="num">Conf.</th></tr></thead>
            <tbody>
              <tr v-for="(q, i) in data.plannedQueries" :key="i">
                <td class="cell-strong" :title="q.rationale">{{ q.query }}</td>
                <td class="mono" style="font-size: 11.5px;">{{ q.platform ?? 'all' }}</td>
                <td class="num mono">{{ Math.round(q.confidence * 100) }}%</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Trace log -->
      <div class="card">
        <div class="card-head"><Icon name="list" :size="12" /><span>Лог ({{ data.trace.length }})</span></div>
        <div class="card-body" style="max-height: 280px; overflow: auto;">
          <div v-if="!data.trace.length" class="placeholder" style="min-height: 40px;">Пока пусто.</div>
          <div v-else style="display: flex; flex-direction: column; gap: 4px;">
            <div v-for="(e, i) in data.trace" :key="i" style="display: flex; gap: 8px; font-size: 11.5px; align-items: baseline;">
              <span class="muted-2 mono" style="font-size: 10px; white-space: nowrap;">{{ formatDateTime(e.ts) }}</span>
              <span
                class="mono"
                :style="{ color: e.status === 'error' ? 'var(--bad)' : e.status === 'ok' ? 'var(--ok)' : 'var(--ink)' }"
              >{{ e.stage }}</span>
              <span class="muted" style="overflow: hidden; text-overflow: ellipsis;">
                <template v-if="e.query">«{{ e.query }}»</template>
                <template v-if="e.resultCount != null"> · {{ e.resultCount }} рез.</template>
                <template v-if="e.candidateCount != null"> · {{ e.candidateCount }} канд.</template>
                <template v-if="e.handle"> · {{ e.handle }}</template>
                <template v-if="e.error"> · <span style="color: var(--bad);">{{ e.error }}</span></template>
                <template v-else-if="e.message"> · {{ e.message }}</template>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Candidates -->
    <div class="card">
      <div class="card-head"><Icon name="users" :size="12" /><span>Кандидаты ({{ candidatesSorted.length }})</span></div>
      <div class="card-body" style="display: flex; flex-direction: column; gap: 8px;">
        <div v-if="!candidatesSorted.length" class="placeholder" style="min-height: 48px;">
          {{ stillRunning ? 'Идёт поиск и разбор…' : 'Кандидатов нет.' }}
        </div>
        <div v-for="c in candidatesSorted" :key="c.id" class="card" style="padding: 0;" data-test="candidate">
          <div class="card-body" style="display: flex; flex-direction: column; gap: 8px;">
            <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
              <Pill :cls="recommendationPill(c.recommendation)">{{ recommendationLabel(c.recommendation) }}</Pill>
              <span class="mono cell-strong">{{ c.platform }}/{{ c.handle }}</span>
              <span class="muted" style="font-size: 12px;">{{ c.title || '—' }}</span>
              <span class="mono" style="font-size: 12px;">{{ scoreLabel(c.score) }}</span>
              <span v-if="c.followers != null" class="muted-2" style="font-size: 11.5px;">{{ formatNumber(c.followers) }} подп.</span>
              <Pill :cls="enrichmentPill(c.enrichmentStatus)">{{ c.enrichmentStatus }}</Pill>
              <Pill v-if="c.decision" :cls="decisionPill(c.decision)">{{ decisionLabel(c.decision) }}</Pill>
            </div>

            <div v-if="c.rationale" class="muted" style="font-size: 12px;">{{ c.rationale }}</div>

            <div v-if="c.riskNotes.length" style="display: flex; gap: 6px; flex-wrap: wrap;">
              <span v-for="(r, ri) in c.riskNotes" :key="ri" class="pill ghost" style="font-size: 10.5px;"><Icon name="warn" :size="10" /> {{ r }}</span>
            </div>

            <div v-if="c.insufficientEvidenceReason" class="muted-2" style="font-size: 11.5px; font-style: italic;">{{ c.insufficientEvidenceReason }}</div>

            <!-- actions -->
            <div style="display: flex; gap: 6px; flex-wrap: wrap; align-items: center;">
              <button class="btn sm" :class="c.decision === 'saved' ? 'ok' : ''" :disabled="actionMut.isPending.value" @click="act(c.id, c.decision === 'saved' ? 'clear' : 'save')"><Icon name="check" :size="11" /> Сохранить</button>
              <button class="btn sm" :class="c.decision === 'shortlisted' ? 'accent' : ''" :disabled="actionMut.isPending.value" @click="act(c.id, c.decision === 'shortlisted' ? 'clear' : 'shortlist')"><Icon name="flag" :size="11" /> В шортлист</button>
              <button class="btn sm" :class="c.decision === 'rejected' ? 'bad' : ''" :disabled="actionMut.isPending.value" @click="act(c.id, c.decision === 'rejected' ? 'clear' : 'reject')"><Icon name="x" :size="11" /> Отклонить</button>
              <button class="btn sm" :disabled="actionMut.isPending.value || launchMut.isPending.value || !c.channelId" @click="act(c.id, 'scrape_refresh')"><Icon name="refresh" :size="11" /> Обновить scrape</button>
              <button
                v-if="canOfferLaunch(c)"
                class="btn sm accent"
                data-test="launch"
                :disabled="actionMut.isPending.value || launchMut.isPending.value"
                @click="openLaunch(c)"
              ><Icon name="zap" :size="11" /> Запустить в работу</button>
              <span v-else-if="c.decision === 'launched'" class="pill accent" style="font-size: 10.5px;"><Icon name="zap" :size="10" /> в работе</span>
              <a v-if="c.url" class="btn sm ghost" :href="c.url" target="_blank" rel="noopener"><Icon name="arrow_up_right" :size="11" /> Открыть</a>
              <button v-if="c.channelId" class="btn sm ghost" @click="openChannel()"><Icon name="hash" :size="11" /> Канал</button>
              <button v-if="c.bloggerProfileId" class="btn sm ghost" @click="openProfile(c.bloggerProfileId)"><Icon name="user" :size="11" /> Профиль</button>
              <button
                v-if="c.evidence.length"
                class="btn sm ghost"
                :aria-expanded="expanded.has(c.id)"
                data-test="toggle-evidence"
                @click="toggle(c.id)"
              >
                <Icon name="list" :size="11" /> Посты ({{ c.evidence.length }})
              </button>
            </div>

            <!-- evidence -->
            <div v-if="expanded.has(c.id) && c.evidence.length" data-test="evidence" style="border-top: 1px solid var(--line); padding-top: 8px; display: flex; flex-direction: column; gap: 8px;">
              <div v-for="(ev, ei) in c.evidence" :key="ei" style="font-size: 12px;">
                <div class="muted-2" style="font-size: 10.5px;">
                  <template v-if="ev.date">{{ ev.date }}</template>
                  <a v-for="(u, ui) in ev.urls" :key="ui" :href="u" target="_blank" rel="noopener" class="mono" style="margin-left: 6px;">ссылка</a>
                </div>
                <div>{{ ev.snippet }}</div>
                <div v-if="ev.why" class="muted" style="font-size: 11px; font-style: italic;">→ {{ ev.why }}</div>
              </div>
            </div>

            <div v-if="c.sourceQueries.length" class="muted-2" style="font-size: 10.5px;">
              нашли по: {{ c.sourceQueries.join(' · ') }}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- launch-into-work confirmation -->
  <Modal
    :open="launchFor != null"
    title="Запустить в работу"
    description="Бизнес-/рекламные контакты канала будут добавлены в кампанию, а опенинг подготовлен как ЧЕРНОВИК на подтверждение оператором. Ничего не отправляется автоматически."
    size="md"
    @close="closeLaunch"
  >
    <div v-if="launchFor" style="display: flex; flex-direction: column; gap: 12px;">
      <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
        <span class="mono cell-strong">{{ launchFor.platform }}/{{ launchFor.handle }}</span>
        <span class="muted" style="font-size: 12px;">{{ launchFor.title || '—' }}</span>
      </div>

      <div v-if="data?.campaignId" class="muted-2" style="font-size: 12px;">
        Кампания запуска по умолчанию — кампания этого поиска. Можно выбрать другую.
      </div>
      <SelectInput v-model="launchCampaignId" :options="campaignOpts" />

      <div v-if="!canLaunch" class="muted-2" style="font-size: 11.5px; color: var(--bad);">
        Выберите кампанию — у поиска нет привязанной кампании.
      </div>
      <div class="muted-2" style="font-size: 11px;">
        В работу берутся только явные бизнес-/рекламные контакты (менеджер по рекламе, владелец).
        Если их нет — сначала выполните scrape / contact-extract.
      </div>
    </div>

    <template #footer>
      <button class="btn" :disabled="launchMut.isPending.value" @click="closeLaunch">Отмена</button>
      <button
        class="btn primary"
        data-test="launch-confirm"
        :disabled="launchMut.isPending.value || !canLaunch"
        @click="confirmLaunch"
      >
        <span v-if="launchMut.isPending.value" class="spinner" />
        <Icon v-else name="zap" :size="11" />
        <span>Запустить в работу</span>
      </button>
    </template>
  </Modal>
</template>
