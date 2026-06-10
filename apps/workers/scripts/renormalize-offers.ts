import { getPrisma } from '@nosquare/db';
import { handleOfferRenormalize } from '../src/queues/offer-renormalize.js';

/**
 * One-shot renormalize of ALL active placement-offer rows (price-
 * normalization-v2 rollout step 3): per-profile recompute so existing rows
 * pick up exchange rates and CPM bases. Idempotent — recompute writes only
 * derived columns. Run: `pnpm db:renormalize:offers`.
 */
async function main(): Promise<void> {
  const prisma = getPrisma();
  const profiles = await prisma.placementOfferRow.findMany({
    where: { status: 'active' },
    select: { profileId: true },
    distinct: ['profileId'],
  });
  console.log(`[renormalize-offers] profiles with active rows: ${profiles.length}`);
  let updated = 0;
  for (const { profileId } of profiles) {
    const res = (await handleOfferRenormalize({ profileId })) as { updated?: number };
    updated += res.updated ?? 0;
  }
  console.log(`[renormalize-offers] done: rows updated=${updated}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[renormalize-offers] failed:', err);
    process.exit(1);
  });
