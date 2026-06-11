<script setup lang="ts">
import { computed } from 'vue';
import Pill from '../../components/Pill.vue';
import { formatCompact, formatRelative } from '../../lib/format';
import { freshnessAgeText, freshnessTone, freshnessTooltip } from './freshness-ui';
import { isRubCurrency, summarizeOffers } from './offer-summary';
import type { PillClass } from '../../lib/state';
import type { BloggerProfile, ProfileFreshnessCategory } from './types';

// Decision-ux: полоса решающих метрик — подписчики (по платформам),
// просмотры, охват, ERR/ER, «цена от», «CPM от». Каждое число несёт inline
// freshness-бейдж вместо отдельной таблицы свежести.
const props = defineProps<{ profile: BloggerProfile }>();

interface MetricBadge {
  text: string;
  tone: PillClass;
  title?: string;
}

interface MetricTile {
  key: string;
  label: string;
  value: string;
  title?: string;
  badge: MetricBadge | null;
}

const summary = computed(() => summarizeOffers(props.profile.placementOffers ?? []));

function freshnessBadge(category: ProfileFreshnessCategory, label: string): MetricBadge | null {
  const section = props.profile.freshness?.[category];
  if (!section) return null;
  return {
    text: freshnessAgeText(section),
    tone: freshnessTone(section),
    title: freshnessTooltip(label, section),
  };
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * «Цена от» fallback for legacy profiles without structured offers: the
 * cheapest RUB rate card. Structured offers win when present.
 */
const priceFrom = computed<{ value: number; stale: boolean } | null>(() => {
  const s = summary.value;
  if (s.priceFromRub != null) return { value: s.priceFromRub, stale: s.priceStale };
  const rub = (props.profile.rateCards ?? []).filter((r) => isRubCurrency(r.currency));
  if (!rub.length) return null;
  return { value: Math.min(...rub.map((r) => r.price)), stale: false };
});

const priceTooltip = computed(() => {
  const lines = summary.value.perPlatform.map(
    (p) => `${p.platform ?? 'без платформы'}: от ${formatCompact(p.priceFromRub!)} ₽${p.stale ? ' (устарело)' : ''}`,
  );
  lines.push('минимум по RUB-нормализованным офферам');
  return lines.join('\n');
});

const tiles = computed<MetricTile[]>(() => {
  const p = props.profile;
  const e = p.engagement ?? null;
  const out: MetricTile[] = [];

  const audience = p.platformAudience ?? [];
  if (audience.length) {
    for (const pa of audience) {
      out.push({
        key: `subs:${pa.platform}`,
        label: `подписчики · ${pa.platform}`,
        value: formatCompact(pa.subscribers),
        badge: pa.capturedAt
          ? { text: formatRelative(pa.capturedAt), tone: 'ghost', title: `Снято: ${pa.capturedAt.slice(0, 10)}` }
          : null,
      });
    }
  } else {
    out.push({
      key: 'subs',
      label: 'подписчики',
      value: '—',
      badge: { text: 'нет данных', tone: 'ghost' },
    });
  }

  out.push({
    key: 'avgViews',
    label: 'ср. просмотры',
    value: p.avgViews != null ? formatCompact(p.avgViews) : '—',
    badge: freshnessBadge('avgViews', 'Ср. просмотры'),
  });
  out.push({
    key: 'reach',
    label: 'охват',
    value: p.reach != null ? formatCompact(p.reach) : '—',
    badge: freshnessBadge('reach', 'Охват'),
  });

  if (e?.err != null) {
    out.push({
      key: 'err',
      label: `ERR (${e.errPlatform})`,
      value: percent(e.err),
      title: `Ср. просмотры ÷ подписчики (${e.errPlatform}${
        e.subscribersBasis != null ? `, ${formatCompact(e.subscribersBasis)}` : ''
      })`,
      badge: freshnessBadge('avgViews', 'ERR'),
    });
  } else {
    out.push({ key: 'err', label: 'ERR', value: '—', badge: { text: 'нет данных', tone: 'ghost' } });
  }

  // Пост-ER: при нескольких платформах — отдельный тайл на платформу.
  const perPlatform = (e?.perPlatform ?? []).filter((pp) => pp.avgPostEr != null);
  if (perPlatform.length > 1) {
    for (const pp of perPlatform) {
      out.push({
        key: `er:${pp.platform}`,
        label: `ER (${pp.platform})`,
        value: percent(pp.avgPostEr!),
        title: `По ${pp.postsBasis} постам`,
        badge: null,
      });
    }
  } else if (e?.avgPostEr != null) {
    out.push({
      key: 'er',
      label: 'ER постов',
      value: percent(e.avgPostEr),
      title: `По ${e.postsBasis} постам`,
      badge: null,
    });
  }

  const price = priceFrom.value;
  out.push({
    key: 'price',
    label: 'цена',
    // Explicit null check: a known price of 0 (барter/бесплатно) is a price.
    value: price != null ? `от ${formatCompact(price.value)} ₽` : 'по запросу',
    title: summary.value.perPlatform.length ? priceTooltip.value : undefined,
    badge: price?.stale
      ? { text: 'устарело', tone: 'warn', title: 'Минимальная цена старше TTL прайсов' }
      : freshnessBadge('rateCards', 'Прайсы'),
  });

  if (summary.value.cpmFromRub != null) {
    out.push({
      key: 'cpm',
      label: 'CPM',
      value: `${summary.value.cpmApprox ? '≈ ' : ''}от ${formatCompact(summary.value.cpmFromRub)} ₽`,
      title: '₽ за 1000 просмотров; ≈ — оценка по средним просмотрам профиля',
      badge: summary.value.cpmStale
        ? { text: 'устарело', tone: 'warn', title: 'Минимальный CPM старше TTL прайсов' }
        : freshnessBadge('rateCards', 'Прайсы'),
    });
  }

  return out;
});
</script>

<template>
  <div class="card">
    <div class="card-body strip">
      <div v-for="t in tiles" :key="t.key" class="stat" :title="t.title">
        <span class="stat__v mono">{{ t.value }}</span>
        <span class="stat__l">{{ t.label }}</span>
        <Pill v-if="t.badge" :cls="t.badge.tone" :dot="false" :title="t.badge.title" class="stat__badge">
          {{ t.badge.text }}
        </Pill>
      </div>
    </div>
  </div>
</template>

<style scoped>
.strip {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.stat {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  min-width: 96px;
  padding: 8px 11px;
  border: 1px solid var(--line);
  border-radius: 9px;
  line-height: 1.15;
}
.stat__v {
  font-weight: 600;
  font-size: 15.5px;
  color: var(--ink);
  white-space: nowrap;
}
.stat__l {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: var(--ink-4);
}
.stat__badge {
  font-size: 9.5px;
}
</style>
