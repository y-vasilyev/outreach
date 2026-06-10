import { Worker } from 'bullmq';
import {
  normalizeOffer,
  OfferRenormalizeJobZ,
  QueueNames,
  resolveViewsBasis,
  type OfferRenormalizeJob,
} from '@nosquare/shared';
import { getPrisma } from '@nosquare/db';
import { getRedis } from '../redis.js';
import { logger } from '../logger.js';

/**
 * offer-renormalize worker (price-normalization-v2): recompute the DERIVED
 * normalization columns (priceRub*, fx*, cpm*, views*) of ACTIVE placement-
 * offer rows. Triggered by (a) an exchange-rate upsert — all active rows in
 * that currency — and (b) a profile's post-insight refresh — that profile's
 * CPM basis. Raw columns are never modified; superseded/low_confidence rows
 * keep the normalization they had (history shows what we believed then).
 */
export async function handleOfferRenormalize(data: OfferRenormalizeJob): Promise<unknown> {
  const prisma = getPrisma();
  const where = {
    status: 'active',
    ...(data.currency ? { currency: { equals: data.currency, mode: 'insensitive' as const } } : {}),
    ...(data.profileId ? { profileId: data.profileId } : {}),
  };
  const rows = await prisma.placementOfferRow.findMany({ where });
  if (rows.length === 0) return { ok: true, updated: 0 };

  const currencies = [
    ...new Set(rows.map((r) => r.currency.toUpperCase()).filter((c) => c !== 'RUB')),
  ];
  const rates = currencies.length
    ? await prisma.exchangeRate.findMany({ where: { currency: { in: currencies } } })
    : [];
  const ratesByCurrency = new Map(rates.map((r) => [r.currency.toUpperCase(), r]));

  // Views bases per profile (CPM denominator), loaded once per profile.
  const profileIds = [...new Set(rows.map((r) => r.profileId))];
  const profiles = await prisma.bloggerProfile.findMany({
    where: { id: { in: profileIds } },
    select: {
      id: true,
      avgViews: true,
      postInsights: {
        select: { platform: true, metrics: true, publishedAt: true, metricCapturedAt: true },
        orderBy: [{ publishedAt: 'desc' }],
        take: 100,
      },
    },
  });
  const profilesById = new Map(profiles.map((p) => [p.id, p]));

  let updated = 0;
  for (const row of rows) {
    const profile = profilesById.get(row.profileId);
    const normalized = normalizeOffer(
      {
        kind: row.kind,
        currency: row.currency,
        priceMin: row.priceMin === null ? null : Number(row.priceMin),
        priceMax: row.priceMax === null ? null : Number(row.priceMax),
      },
      ratesByCurrency.get(row.currency.toUpperCase()) ?? null,
      resolveViewsBasis(profile?.postInsights ?? [], row.platform, profile?.avgViews ?? null),
    );
    await prisma.placementOfferRow.update({
      where: { id: row.id },
      data: {
        priceRubMin: normalized.priceRubMin,
        priceRubMax: normalized.priceRubMax,
        fxRateUsed: normalized.fxRateUsed,
        fxAsOf: normalized.fxAsOf,
        cpmRub: normalized.cpmRub,
        viewsBasis: normalized.viewsBasis,
        viewsSource: normalized.viewsSource,
      },
    });
    updated += 1;
  }
  logger.info(
    { event: 'offer.renormalized', currency: data.currency, profileId: data.profileId, updated },
    'active placement-offer rows renormalized',
  );
  return { ok: true, updated };
}

export function startOfferRenormalizeWorker() {
  const worker = new Worker(
    QueueNames.offerRenormalize,
    async (job) => handleOfferRenormalize(OfferRenormalizeJobZ.parse(job.data)),
    { connection: getRedis(), concurrency: 1 },
  );
  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err?.message }, 'offer-renormalize failed');
  });
  return worker;
}
