import { describe, it, expect } from 'vitest';
import { PlacementOfferZ, type PlacementOffer } from '@nosquare/shared';
import {
  persistPlacementOfferRow,
  supersedeOfferRowsForMessage,
} from '../placement-offer-rows.js';

/**
 * placement-offer-table: the thin Prisma write helper against an in-memory
 * fake transaction — proves chain semantics, idempotency and the operator
 * re-run supersede without a database. (The decision logic itself is covered
 * in @nosquare/shared placement-offer-rows tests; here we prove the plumbing:
 * flip-before-insert ordering, supersededById closure, no deletes ever.)
 */

interface Row {
  id: string;
  profileId: string;
  identityKey: string;
  status: string;
  supersededById: string | null;
  priceMin: number | null;
  currency: string;
  confidence: number;
  capturedAt: Date;
  sourceDataPointId: string | null;
  sourceMessageId: string | null;
  [k: string]: unknown;
}

function fakeTx() {
  const rows: Row[] = [];
  let seq = 0;
  const matches = (row: Row, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v !== null && typeof v === 'object' && 'in' in (v as object)) {
        return ((v as { in: unknown[] }).in).includes(row[k]);
      }
      return row[k] === v;
    });
  const tx = {
    placementOfferRow: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((r) => matches(r, where)) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `row_${++seq}`, supersededById: null, ...data } as Row;
        // Emulate the partial unique index: one active row per identity.
        if (
          row.status === 'active' &&
          rows.some(
            (r) =>
              r.status === 'active' &&
              r.profileId === row.profileId &&
              r.identityKey === row.identityKey,
          )
        ) {
          throw new Error('unique violation: placement_offer_one_active_per_identity');
        }
        rows.push(row);
        return { id: row.id };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = rows.filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
    },
    rows,
  };
  return tx;
}

function offer(over: Partial<PlacementOffer> = {}): PlacementOffer {
  return PlacementOfferZ.parse({
    kind: 'post',
    platform: 'telegram',
    price: 40000,
    currency: 'RUB',
    attributes: [{ key: 'duration', value: 'month', confidence: 1, rawSnippet: '' }],
    confidence: 0.9,
    rawSnippet: 'пост на месяц 40000',
    sourceMessageId: 'm1',
    extractedBy: 'rate_card_extractor',
    capturedAt: '2026-06-01T00:00:00.000Z',
    ...over,
  });
}

const asTx = (t: ReturnType<typeof fakeTx>) => t as unknown as Parameters<typeof persistPlacementOfferRow>[0];

describe('persistPlacementOfferRow', () => {
  it('price change builds a supersede chain — nothing is deleted', async () => {
    const tx = fakeTx();
    await persistPlacementOfferRow(asTx(tx), { profileId: 'p1', offer: offer(), sourceDataPointId: 'dp1' });
    await persistPlacementOfferRow(asTx(tx), {
      profileId: 'p1',
      offer: offer({ price: 47000, capturedAt: '2026-06-10T00:00:00.000Z', sourceMessageId: 'm2' }),
      sourceDataPointId: 'dp2',
    });
    expect(tx.rows).toHaveLength(2);
    const active = tx.rows.find((r) => r.status === 'active')!;
    const old = tx.rows.find((r) => r.status === 'superseded')!;
    expect(active.priceMin).toBe(47000);
    expect(old.priceMin).toBe(40000);
    expect(old.supersededById).toBe(active.id);
  });

  it('is idempotent on (profileId, sourceDataPointId)', async () => {
    const tx = fakeTx();
    const first = await persistPlacementOfferRow(asTx(tx), { profileId: 'p1', offer: offer(), sourceDataPointId: 'dp1' });
    const second = await persistPlacementOfferRow(asTx(tx), { profileId: 'p1', offer: offer(), sourceDataPointId: 'dp1' });
    expect(first).toBe('created');
    expect(second).toBe('skipped');
    expect(tx.rows).toHaveLength(1);
  });

  it('low-confidence offers are stored inert (no supersede, never active)', async () => {
    const tx = fakeTx();
    await persistPlacementOfferRow(asTx(tx), { profileId: 'p1', offer: offer(), sourceDataPointId: 'dp1' });
    await persistPlacementOfferRow(asTx(tx), {
      profileId: 'p1',
      offer: offer({ price: 99000, confidence: 0.1 }),
      sourceDataPointId: 'dp2',
    });
    expect(tx.rows.find((r) => r.sourceDataPointId === 'dp2')!.status).toBe('low_confidence');
    expect(tx.rows.find((r) => r.sourceDataPointId === 'dp1')!.status).toBe('active');
  });

  it('chronological replay (backfill order) reproduces the same chain as live dual-write', async () => {
    const generations = [
      offer({ price: 40000, capturedAt: '2026-05-01T00:00:00.000Z' }),
      offer({ price: 47000, capturedAt: '2026-06-01T00:00:00.000Z' }),
      offer({ price: 52000, capturedAt: '2026-06-09T00:00:00.000Z' }),
    ];
    const tx = fakeTx();
    for (const [i, o] of generations.entries()) {
      await persistPlacementOfferRow(asTx(tx), { profileId: 'p1', offer: o, sourceDataPointId: `dp${i}` });
    }
    expect(tx.rows.filter((r) => r.status === 'active')).toHaveLength(1);
    expect(tx.rows.find((r) => r.status === 'active')!.priceMin).toBe(52000);
    const chain = tx.rows.filter((r) => r.status === 'superseded');
    expect(chain.map((r) => r.priceMin)).toEqual([40000, 47000]);
    expect(chain.every((r) => r.supersededById !== null)).toBe(true);
  });
});

describe('supersedeOfferRowsForMessage', () => {
  it('marks the message generation superseded without deleting; other messages untouched', async () => {
    const tx = fakeTx();
    await persistPlacementOfferRow(asTx(tx), { profileId: 'p1', offer: offer(), sourceDataPointId: 'dp1' });
    await persistPlacementOfferRow(asTx(tx), {
      profileId: 'p1',
      offer: offer({
        sourceMessageId: 'm2',
        attributes: [{ key: 'duration', value: 'day', confidence: 1, rawSnippet: '' }],
        rawSnippet: 'пост на сутки 20000',
        price: 20000,
      }),
      sourceDataPointId: 'dp2',
    });
    const count = await supersedeOfferRowsForMessage(asTx(tx), { profileId: 'p1', sourceMessageId: 'm1' });
    expect(count).toBe(1);
    expect(tx.rows).toHaveLength(2);
    expect(tx.rows.find((r) => r.sourceMessageId === 'm1')!.status).toBe('superseded');
    expect(tx.rows.find((r) => r.sourceMessageId === 'm2')!.status).toBe('active');
  });
});
