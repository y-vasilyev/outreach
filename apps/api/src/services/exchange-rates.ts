import { getPrisma } from '@nosquare/db';
import type { ExchangeRateUpsert, ExchangeRateView } from '@nosquare/shared';
import { getQueues } from '../queues.js';
import { logger } from '../logger.js';

/**
 * Operator-maintained exchange rates (price-normalization-v2). The table holds
 * the CURRENT rate per currency (an edit overwrites); historical traceability
 * lives on each offer row via fxRateUsed/fxAsOf stamps. Every mutation
 * enqueues `offer-renormalize` for the affected currency so active rows pick
 * up the new rate; superseded rows keep the normalization they had.
 */

function toView(row: {
  currency: string;
  rateToRub: unknown;
  asOf: Date;
  source: string;
  updatedById: string | null;
  updatedAt: Date;
}): ExchangeRateView {
  return {
    currency: row.currency,
    rateToRub: Number(row.rateToRub),
    asOf: row.asOf.toISOString(),
    source: row.source,
    updatedById: row.updatedById,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function enqueueRenormalize(currency: string): Promise<void> {
  try {
    await getQueues().offerRenormalize.add('renormalize', { currency });
  } catch (err) {
    // Best-effort: a failed enqueue leaves rows on the OLD rate until the next
    // mutation/manual renormalize — visible via fxAsOf, never silently wrong.
    logger.warn({ currency, err: (err as Error).message }, 'offer-renormalize enqueue failed');
  }
}

export const exchangeRatesService = {
  async list(): Promise<ExchangeRateView[]> {
    const prisma = getPrisma();
    const rows = await prisma.exchangeRate.findMany({ orderBy: { currency: 'asc' } });
    return rows.map(toView);
  },

  async upsert(
    currency: string,
    input: ExchangeRateUpsert,
    userId: string,
  ): Promise<ExchangeRateView> {
    const prisma = getPrisma();
    const asOf = input.asOf ?? new Date();
    const row = await prisma.exchangeRate.upsert({
      where: { currency },
      update: { rateToRub: input.rateToRub, asOf, source: 'manual', updatedById: userId },
      create: {
        currency,
        rateToRub: input.rateToRub,
        asOf,
        source: 'manual',
        updatedById: userId,
      },
    });
    await enqueueRenormalize(currency);
    return toView(row);
  },

  async remove(currency: string): Promise<void> {
    const prisma = getPrisma();
    await prisma.exchangeRate.deleteMany({ where: { currency } });
    // Re-run normalization so the currency's active rows drop to unnormalized
    // (excluded from RUB comparisons) instead of keeping a deleted rate.
    await enqueueRenormalize(currency);
  },
};
