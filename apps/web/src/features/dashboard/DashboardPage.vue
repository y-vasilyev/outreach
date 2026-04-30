<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { useRouter } from 'vue-router';
import PageHead from '../../components/PageHead.vue';
import Pill from '../../components/Pill.vue';
import Spinner from '../../components/Spinner.vue';
import Icon from '../../components/Icon.vue';
import { api } from '../../lib/api';
import { formatMoney, formatNumber, formatPct, formatRelative } from '../../lib/format';
import type { DashboardData } from './types';
import type { IconName } from '../../lib/icons';

const router = useRouter();

const fallback: DashboardData = {
  channels: { total: 0, new: 0, scraping: 0, extracted: 0, failed: 0 },
  contacts: { total: 0, reachableTg: 0, manual: 0 },
  conversations: { active: 0, assisted: 0, manual: 0, auto: 0 },
  campaigns: { running: 0, paused: 0 },
  cost: { tokensToday: 0, costTodayUsd: 0, cost7dUsd: 0 },
  replyRate7d: 0,
  recentActivity: [],
};

const { data, isLoading } = useQuery({
  queryKey: ['dashboard'],
  queryFn: () => api.get<DashboardData>('/metrics/dashboard'),
  refetchInterval: 30_000,
});

const d = computed<DashboardData>(() => data.value ?? fallback);

const stats = computed(() => [
  { label: 'Каналы', value: formatNumber(d.value.channels.total), hint: `${formatNumber(d.value.channels.extracted)} с контактами`, to: '/channels', icon: 'layers', color: 'var(--accent-2)' },
  { label: 'Контакты', value: formatNumber(d.value.contacts.total), hint: `${formatNumber(d.value.contacts.reachableTg)} TG · ${formatNumber(d.value.contacts.manual)} manual`, to: '/contacts', icon: 'users_round', color: 'var(--ok)' },
  { label: 'Активные диалоги', value: formatNumber(d.value.conversations.active), hint: `Assisted ${d.value.conversations.assisted} · Manual ${d.value.conversations.manual}`, to: '/inbox', icon: 'chat', color: 'var(--violet)' },
  { label: 'Стоимость / 7д', value: formatMoney(d.value.cost.cost7dUsd), hint: `${formatMoney(d.value.cost.costTodayUsd)} сегодня`, icon: 'database', color: 'var(--warn)' },
] as Array<{ label: string; value: string; hint?: string; to?: string; icon: IconName; color: string }>);

const funnelSteps = computed(() => [
  { state: 'new', count: d.value.channels.new },
  { state: 'scraping', count: d.value.channels.scraping },
  { state: 'extracted', count: d.value.channels.extracted },
  { state: 'failed', count: d.value.channels.failed },
  { state: 'ready', count: Math.max(0, d.value.channels.total - d.value.channels.new - d.value.channels.scraping - d.value.channels.failed) },
]);

const kpiRows = computed(() => [
  { label: 'Reply-rate (7д)', value: formatPct(d.value.replyRate7d), color: 'var(--ok)' },
  { label: 'Кампании running', value: formatNumber(d.value.campaigns.running), color: 'var(--accent-2)' },
  { label: 'Tokens сегодня', value: formatNumber(d.value.cost.tokensToday), color: 'var(--ink-2)' },
  { label: 'Conv. на оператора', value: formatNumber(d.value.conversations.manual), color: 'var(--violet)' },
]);

function activityIcon(type: string): IconName {
  switch (type) {
    case 'message_sent': return 'send';
    case 'reply': return 'chat';
    case 'failed':
    case 'escalation': return 'warn';
    default: return 'check_circle';
  }
}

function activityTone(type: string): string {
  switch (type) {
    case 'failed': return 'var(--bad)';
    case 'escalation': return 'var(--warn)';
    case 'reply': return 'var(--ok)';
    default: return 'var(--accent-2)';
  }
}
</script>

<template>
  <PageHead title="Дашборд" sub="Сводка по каналам, контактам, диалогам и стоимости агентов" />

  <div v-if="isLoading && !data" class="center"><Spinner /></div>
  <div v-else class="cards" style="grid-template-columns: 1fr;">
    <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px;">
      <div
        v-for="s in stats"
        :key="s.label"
        class="card"
        :style="{ cursor: s.to ? 'pointer' : 'default' }"
        @click="s.to && router.push(s.to)"
      >
        <div style="padding: 14px 16px;">
          <div style="display: flex; justify-content: space-between; align-items: flex-start;">
            <div>
              <div class="muted-2" style="font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 500;">{{ s.label }}</div>
              <div class="mono" style="font-size: 22px; font-weight: 600; letter-spacing: -0.02em; margin-top: 6px;">{{ s.value }}</div>
            </div>
            <span :style="{ width: '28px', height: '28px', borderRadius: '6px', background: 'var(--paper-3)', color: s.color, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }">
              <Icon :name="s.icon" :size="14" />
            </span>
          </div>
          <div v-if="s.hint" class="muted-2" style="margin-top: 8px; font-size: 11px;">{{ s.hint }}</div>
        </div>
      </div>
    </div>

    <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 12px;">
      <div class="card">
        <div class="card-head">
          <Icon name="layers" :size="12" /><span>Воронка каналов</span>
          <div class="actions"><a class="btn ghost sm" @click="router.push('/channels')">Открыть список →</a></div>
        </div>
        <div class="card-body">
          <div style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px;">
            <div v-for="f in funnelSteps" :key="f.state" style="background: var(--paper-2); border: 1px solid var(--line); padding: 10px 12px; border-radius: var(--r-sm);">
              <Pill :state="f.state" />
              <div class="mono cell-strong" style="font-size: 18px; margin-top: 6px;">{{ formatNumber(f.count) }}</div>
            </div>
          </div>
          <div class="placeholder" style="margin-top: 14px; min-height: 80px;">График активности (placeholder)</div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><Icon name="trend" :size="12" /><span>KPI диалогов</span></div>
        <div class="card-body">
          <ul style="margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px;">
            <li v-for="r in kpiRows" :key="r.label" style="display: flex; align-items: center; justify-content: space-between; font-size: 12.5px;">
              <span class="muted">{{ r.label }}</span>
              <span class="mono" :style="{ color: r.color, fontWeight: 600 }">{{ r.value }}</span>
            </li>
          </ul>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <Icon name="clock" :size="12" /><span>Последняя активность</span>
        <div class="actions"><a class="btn ghost sm" @click="router.push('/audit')">Полный аудит →</a></div>
      </div>
      <div class="card-body">
        <div v-if="d.recentActivity.length === 0" class="muted" style="text-align: center; padding: 18px; font-size: 12.5px;">Активности пока нет</div>
        <div v-else style="display: flex; flex-direction: column;">
          <div
            v-for="ev in d.recentActivity"
            :key="ev.id"
            style="display: flex; align-items: flex-start; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--line);"
          >
            <span :style="{ width: '24px', height: '24px', borderRadius: '6px', background: 'var(--paper-2)', color: activityTone(ev.type), display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }">
              <Icon :name="activityIcon(ev.type)" :size="12" />
            </span>
            <div style="flex: 1; min-width: 0;">
              <div class="cell-strong ellipsis" style="font-size: 12.5px;">{{ ev.title }}</div>
              <div v-if="ev.subtitle" class="muted-2" style="font-size: 11px;">{{ ev.subtitle }}</div>
            </div>
            <span class="mono muted-2" style="font-size: 10.5px; white-space: nowrap;">{{ formatRelative(ev.at) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
