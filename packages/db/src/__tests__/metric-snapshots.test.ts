import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { metricSnapshotEntries, recordMetricSnapshots } from '../metric-snapshots.js';

/**
 * blogger-dynamics: snapshot writes against an in-memory fake transaction —
 * proves change-only appends (no duplicate rows for unchanged values) and the
 * per-platform subscriber keys without a database.
 */

interface SnapRow {
  id: string;
  profileId: string;
  metric: string;
  value: number;
  capturedAt: Date;
  source: string;
}

function fakeTx(initial: SnapRow[] = []) {
  const rows = [...initial];
  let seq = rows.length;
  const tx = {
    profileMetricSnapshot: {
      findMany: async (args: {
        where: { profileId: string; metric: { in: string[] } };
        distinct: string[];
      }) => {
        const matching = rows
          .filter(
            (r) => r.profileId === args.where.profileId && args.where.metric.in.includes(r.metric),
          )
          .sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime() || b.id.localeCompare(a.id));
        const seen = new Set<string>();
        return matching.filter((r) => (seen.has(r.metric) ? false : (seen.add(r.metric), true)));
      },
      createMany: async (args: { data: Array<Omit<SnapRow, 'id' | 'capturedAt'>> }) => {
        for (const d of args.data) {
          rows.push({ ...d, id: `s${++seq}`, capturedAt: new Date() } as SnapRow);
        }
        return { count: args.data.length };
      },
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, rows };
}

describe('metricSnapshotEntries', () => {
  it('maps numeric metrics including per-platform subscribers', () => {
    expect(
      metricSnapshotEntries({
        avgViews: 4200,
        reach: 10000,
        platformAudience: [
          { platform: 'Telegram', subscribers: 100000 },
          { platform: 'youtube', subscribers: 500000 },
          { platform: '  ', subscribers: 1 },
        ],
      }),
    ).toEqual([
      { metric: 'avgViews', value: 4200 },
      { metric: 'reach', value: 10000 },
      { metric: 'subscribers:telegram', value: 100000 },
      { metric: 'subscribers:youtube', value: 500000 },
    ]);
  });

  it('skips null metrics entirely', () => {
    expect(metricSnapshotEntries({ avgViews: null, reach: null, platformAudience: [] })).toEqual([]);
  });
});

describe('recordMetricSnapshots', () => {
  const rolled = {
    avgViews: 4200,
    reach: null,
    platformAudience: [{ platform: 'telegram', subscribers: 100000 }],
  };

  it('appends a snapshot per metric on first observation', async () => {
    const { tx, rows } = fakeTx();
    const written = await recordMetricSnapshots(tx, 'p1', rolled);
    expect(written).toBe(2);
    expect(rows.map((r) => [r.metric, r.value, r.source])).toEqual([
      ['avgViews', 4200, 'rollup'],
      ['subscribers:telegram', 100000, 'rollup'],
    ]);
  });

  it('is silent when values match the latest snapshot (re-roll without change)', async () => {
    const { tx, rows } = fakeTx();
    await recordMetricSnapshots(tx, 'p1', rolled);
    const written = await recordMetricSnapshots(tx, 'p1', rolled);
    expect(written).toBe(0);
    expect(rows).toHaveLength(2);
  });

  it('appends only the changed metric', async () => {
    const { tx, rows } = fakeTx();
    await recordMetricSnapshots(tx, 'p1', rolled);
    const written = await recordMetricSnapshots(tx, 'p1', {
      ...rolled,
      platformAudience: [{ platform: 'telegram', subscribers: 101000 }],
    });
    expect(written).toBe(1);
    expect(rows.at(-1)).toMatchObject({ metric: 'subscribers:telegram', value: 101000 });
    expect(rows).toHaveLength(3);
  });

  it('records a change back to a previous value (series tracks runs, not sets)', async () => {
    const { tx, rows } = fakeTx();
    await recordMetricSnapshots(tx, 'p1', rolled); // 4200
    await recordMetricSnapshots(tx, 'p1', { ...rolled, avgViews: 5000 });
    const written = await recordMetricSnapshots(tx, 'p1', rolled); // back to 4200
    expect(written).toBe(1);
    expect(rows.filter((r) => r.metric === 'avgViews').map((r) => r.value)).toEqual([
      4200, 5000, 4200,
    ]);
  });
});
