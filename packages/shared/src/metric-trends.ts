import type { OfferHistoryEntry } from './placement-offer-rows.js';

/**
 * Metric trends (blogger-dynamics): pure derivation of per-metric time series
 * + deltas for the profile detail. Three sources, one shape:
 *
 * - `profile_metric_snapshot` rows — the authoritative change-only series
 *   going forward (avgViews / reach / subscribers:<platform>);
 * - numeric profile data points INCLUDING superseded generations — backfill
 *   for observations made before the snapshot table existed (only points
 *   older than the metric's earliest snapshot are used, so one observation
 *   never appears twice);
 * - placement_offer superseded chains (`buildOfferHistory`) — the price
 *   series per offer identity. Price/CPM are never snapshotted separately.
 *
 * All rates of change are fractions: 0.12 = +12%.
 */

export interface MetricTrendPoint {
  value: number;
  capturedAt: string;
}

export interface MetricTrend {
  /** 'avgViews' | 'reach' | 'subscribers:<platform>' */
  metric: string;
  /** Oldest → newest; consecutive equal values deduped; capped to the newest 50. */
  points: MetricTrendPoint[];
  /** (last − prev) / prev — null with <2 points or a zero base. */
  deltaPrev: number | null;
  /** Change vs the newest point at least 30 days old — null when the series is younger. */
  delta30d: number | null;
}

export interface OfferPriceTrend {
  identityKey: string;
  platform: string | null;
  kind: string;
  currency: string;
  /** priceMin series, oldest → newest (active + superseded generations). */
  points: MetricTrendPoint[];
  deltaPrev: number | null;
}

export interface BloggerProfileTrends {
  metrics: MetricTrend[];
  offers: OfferPriceTrend[];
}

const POINT_CAP = 50;
const DELTA_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function toMs(v: Date | string): number {
  return v instanceof Date ? v.getTime() : Date.parse(v);
}

function toIso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function toFiniteNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[\s,]/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Same field → metric mapping the rollup uses (profile-rollup.ts). */
export function metricForDataPointField(field: string): string | null {
  if (field === 'reach' || field.startsWith('reach.')) return 'reach';
  if (field === 'views.avg' || field === 'avg_views' || field === 'views' || field.startsWith('views.')) {
    return 'avgViews';
  }
  const m = /^audience\.subscribers\.([a-z0-9_]+)$/.exec(field);
  if (m) return `subscribers:${m[1]}`;
  return null;
}

function relativeDelta(from: number, to: number): number | null {
  if (from === 0) return null;
  return Math.round(((to - from) / from) * 10_000) / 10_000;
}

/** Sort asc, drop consecutive repeats, cap to the newest POINT_CAP. */
function normalizeSeries(points: MetricTrendPoint[]): MetricTrendPoint[] {
  const sorted = [...points].sort((a, b) => toMs(a.capturedAt) - toMs(b.capturedAt));
  const deduped: MetricTrendPoint[] = [];
  for (const p of sorted) {
    if (deduped.length > 0 && deduped[deduped.length - 1]!.value === p.value) continue;
    deduped.push(p);
  }
  return deduped.slice(-POINT_CAP);
}

function deltas(points: MetricTrendPoint[], nowMs: number): { deltaPrev: number | null; delta30d: number | null } {
  if (points.length < 2) return { deltaPrev: null, delta30d: null };
  const last = points[points.length - 1]!;
  const prev = points[points.length - 2]!;
  const deltaPrev = relativeDelta(prev.value, last.value);
  const cutoff = nowMs - DELTA_WINDOW_MS;
  // The newest point that is at least 30 days old (excluding the last point).
  let base: MetricTrendPoint | null = null;
  for (const p of points.slice(0, -1)) {
    if (toMs(p.capturedAt) <= cutoff) base = p;
  }
  return { deltaPrev, delta30d: base ? relativeDelta(base.value, last.value) : null };
}

export interface MetricTrendsInput {
  snapshots: ReadonlyArray<{ metric: string; value: number; capturedAt: Date | string }>;
  /** Numeric profile data points INCLUDING superseded — pre-snapshot backfill. */
  dataPoints?: ReadonlyArray<{ field: string; value: unknown; capturedAt: Date | string }>;
  offerHistory?: OfferHistoryEntry[];
  now?: Date | string;
}

export function buildMetricTrends(input: MetricTrendsInput): BloggerProfileTrends {
  const nowMs = input.now != null ? toMs(input.now) : Date.now();

  const byMetric = new Map<string, MetricTrendPoint[]>();
  const earliestSnapshotMs = new Map<string, number>();
  for (const s of input.snapshots) {
    const arr = byMetric.get(s.metric) ?? [];
    arr.push({ value: s.value, capturedAt: toIso(s.capturedAt) });
    byMetric.set(s.metric, arr);
    const ms = toMs(s.capturedAt);
    const cur = earliestSnapshotMs.get(s.metric);
    if (cur == null || ms < cur) earliestSnapshotMs.set(s.metric, ms);
  }
  // Backfill collapses to ONE point per (metric, day): a single extraction
  // run can emit several facts that roll into the same metric (reach.post +
  // reach.story), and treating those as chronology would fabricate a delta
  // out of one observation (codex review). The latest point of the day wins —
  // an approximation of the rollup's pick, anchored by the snapshot series
  // from the first snapshot onward.
  const backfill = new Map<string, Map<string, { value: number; ms: number }>>();
  for (const dp of input.dataPoints ?? []) {
    const metric = metricForDataPointField(dp.field);
    if (!metric) continue;
    const value = toFiniteNumber(dp.value);
    if (value === undefined) continue;
    const ms = toMs(dp.capturedAt);
    if (!Number.isFinite(ms)) continue;
    // Backfill only BEFORE the snapshot era of this metric — a rolled value
    // observed after that is already in the snapshot series.
    const snapshotStart = earliestSnapshotMs.get(metric);
    if (snapshotStart != null && ms >= snapshotStart) continue;
    const day = toIso(dp.capturedAt).slice(0, 10);
    const days = backfill.get(metric) ?? new Map<string, { value: number; ms: number }>();
    const cur = days.get(day);
    if (!cur || ms >= cur.ms) days.set(day, { value: Math.round(value), ms });
    backfill.set(metric, days);
  }
  for (const [metric, days] of backfill) {
    const arr = byMetric.get(metric) ?? [];
    for (const { value, ms } of days.values()) {
      arr.push({ value, capturedAt: new Date(ms).toISOString() });
    }
    byMetric.set(metric, arr);
  }

  const metrics: MetricTrend[] = [...byMetric.entries()]
    .map(([metric, raw]) => {
      const points = normalizeSeries(raw);
      return { metric, points, ...deltas(points, nowMs) };
    })
    .filter((t) => t.points.length > 0)
    .sort((a, b) => a.metric.localeCompare(b.metric));

  const offers: OfferPriceTrend[] = [];
  for (const entry of input.offerHistory ?? []) {
    // No CURRENT price → no dynamics: a «по запросу» offer must not carry a
    // «к прошлой цене» delta built purely from history (codex review).
    if (!entry.active || entry.active.priceMin == null) continue;
    const all = [...entry.history, ...(entry.active ? [entry.active] : [])]
      // Low-confidence captures are not observations of the real price.
      .filter((r) => r.status !== 'low_confidence' && r.priceMin != null);
    // Offer identity excludes currency, so a requote in another currency
    // supersedes into the same chain; comparing raw numbers across currencies
    // would fabricate a huge delta (codex review). The series sticks to the
    // CURRENT currency (active row, else the newest observation).
    const seriesCurrency =
      entry.active?.currency ?? [...all].sort((a, b) => toMs(b.capturedAt) - toMs(a.capturedAt))[0]?.currency;
    const rows = all.filter((r) => r.currency === seriesCurrency);
    const points = normalizeSeries(
      rows.map((r) => ({ value: r.priceMin!, capturedAt: toIso(r.capturedAt) })),
    );
    // A single observation carries no dynamics — keep the payload lean.
    if (points.length < 2) continue;
    offers.push({
      identityKey: entry.identityKey,
      platform: entry.platform,
      kind: entry.kind,
      currency: seriesCurrency ?? 'RUB',
      points,
      deltaPrev: deltas(points, nowMs).deltaPrev,
    });
  }

  return { metrics, offers };
}
