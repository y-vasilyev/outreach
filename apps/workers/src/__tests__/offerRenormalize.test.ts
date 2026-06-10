import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * offer-renormalize worker (price-normalization-v2): recompute DERIVED columns
 * of ACTIVE rows only — by currency (rate change) or by profile (views basis).
 */
const mocks = vi.hoisted(() => {
  const prisma = {
    placementOfferRow: { findMany: vi.fn(), update: vi.fn() },
    exchangeRate: { findMany: vi.fn() },
    bloggerProfile: { findMany: vi.fn() },
  };
  return { prisma };
});

vi.mock('@nosquare/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nosquare/db')>();
  return { ...actual, getPrisma: () => mocks.prisma };
});
vi.mock('bullmq', () => ({ Worker: class {}, Queue: class {} }));
vi.mock('../redis.js', () => ({ getRedis: () => ({}) }));

import { handleOfferRenormalize } from '../queues/offer-renormalize.js';

const usdRow = {
  id: 'r1',
  profileId: 'p1',
  platform: 'telegram',
  kind: 'post',
  priceMin: 400,
  priceMax: 400,
  currency: 'USD',
  status: 'active',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.placementOfferRow.findMany.mockResolvedValue([usdRow]);
  mocks.prisma.placementOfferRow.update.mockResolvedValue({});
  mocks.prisma.exchangeRate.findMany.mockResolvedValue([
    { currency: 'USD', rateToRub: 92.4, asOf: new Date('2026-06-01T00:00:00Z') },
  ]);
  mocks.prisma.bloggerProfile.findMany.mockResolvedValue([
    {
      id: 'p1',
      avgViews: 10000,
      postInsights: [],
    },
  ]);
});

describe('handleOfferRenormalize', () => {
  it('rate change recomputes only ACTIVE rows of that currency, derived columns only', async () => {
    const res = await handleOfferRenormalize({ currency: 'USD' });
    expect(res).toMatchObject({ ok: true, updated: 1 });
    // The query scopes to active rows of the currency.
    const where = (mocks.prisma.placementOfferRow.findMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    }).where;
    expect(where).toMatchObject({ status: 'active' });
    expect(where['currency']).toMatchObject({ equals: 'USD' });
    // Update writes ONLY derived columns (raw price/identity untouched).
    const upd = (mocks.prisma.placementOfferRow.update.mock.calls[0]![0] as {
      where: { id: string };
      data: Record<string, unknown>;
    });
    expect(upd.where.id).toBe('r1');
    expect(Object.keys(upd.data).sort()).toEqual([
      'cpmRub',
      'fxAsOf',
      'fxRateUsed',
      'priceRubMin',
      'priceRubMax',
      'viewsBasis',
      'viewsSource',
    ].sort());
    expect(upd.data['priceRubMin']).toBe(36960);
    expect(upd.data['cpmRub']).toBe(3696); // avgViews fallback basis
    expect(upd.data['viewsSource']).toBe('profile_avg');
  });

  it('deleted rate → derived columns drop to null (visible, excluded from ₽-filters)', async () => {
    mocks.prisma.exchangeRate.findMany.mockResolvedValue([]);
    await handleOfferRenormalize({ currency: 'USD' });
    const upd = (mocks.prisma.placementOfferRow.update.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    });
    expect(upd.data['priceRubMin']).toBeNull();
    expect(upd.data['cpmRub']).toBeNull();
  });

  it('profile mode scopes to the profile and recomputes CPM', async () => {
    mocks.prisma.placementOfferRow.findMany.mockResolvedValue([
      { ...usdRow, id: 'r2', currency: 'RUB', priceMin: 47000, priceMax: 47000 },
    ]);
    await handleOfferRenormalize({ profileId: 'p1' });
    const where = (mocks.prisma.placementOfferRow.findMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    }).where;
    expect(where).toMatchObject({ status: 'active', profileId: 'p1' });
    const upd = (mocks.prisma.placementOfferRow.update.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    });
    expect(upd.data['priceRubMin']).toBe(47000);
    expect(upd.data['fxRateUsed']).toBe(1);
    expect(upd.data['cpmRub']).toBe(4700);
  });
});
