import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/**
 * Metric-snapshot writes (blogger-dynamics). A snapshot row is appended only
 * when the rolled-up numeric value DIFFERS from the metric's latest snapshot,
 * so re-rolls that change nothing stay silent and the series records changes,
 * not runs. Called from both rollup writers (worker profile-extract and the
 * shared reroll) inside their transaction.
 *
 * Price/CPM are deliberately absent: the placement_offer superseded chains
 * already form a complete price series (see buildOfferHistory).
 */
export interface MetricSnapshotSource {
  avgViews: number | null;
  reach: number | null;
  platformAudience: ReadonlyArray<{ platform: string; subscribers: number }>;
}

export function metricSnapshotEntries(
  rolled: MetricSnapshotSource,
): Array<{ metric: string; value: number }> {
  const out: Array<{ metric: string; value: number }> = [];
  if (rolled.avgViews != null) out.push({ metric: 'avgViews', value: rolled.avgViews });
  if (rolled.reach != null) out.push({ metric: 'reach', value: rolled.reach });
  for (const pa of rolled.platformAudience) {
    const platform = pa.platform.trim().toLowerCase();
    if (!platform) continue;
    out.push({ metric: `subscribers:${platform}`, value: pa.subscribers });
  }
  return out;
}

export async function recordMetricSnapshots(
  tx: Tx,
  profileId: string,
  rolled: MetricSnapshotSource,
): Promise<number> {
  const entries = metricSnapshotEntries(rolled);
  if (entries.length === 0) return 0;
  // Latest snapshot per metric (first row per metric under capturedAt desc).
  const latest = await tx.profileMetricSnapshot.findMany({
    where: { profileId, metric: { in: entries.map((e) => e.metric) } },
    orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }],
    distinct: ['metric'],
    select: { metric: true, value: true },
  });
  const latestByMetric = new Map(latest.map((s) => [s.metric, Number(s.value)]));
  const changed = entries.filter((e) => latestByMetric.get(e.metric) !== e.value);
  if (changed.length === 0) return 0;
  await tx.profileMetricSnapshot.createMany({
    data: changed.map((e) => ({
      profileId,
      metric: e.metric,
      value: e.value,
      source: 'rollup',
    })),
  });
  return changed.length;
}
