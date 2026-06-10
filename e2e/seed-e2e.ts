import bcrypt from 'bcryptjs';
import { getPrisma } from '@nosquare/db';

/**
 * Minimal e2e seed (catalog-filters spec): an admin login, the
 * `agency_sourcing` flag ON (the catalog routes are gated by it), and three
 * blogger profiles whose offers make the filter assertions unambiguous:
 *
 *   eg-tg-cheap   — telegram post 47 000 ₽ (fresh)        → matches the query
 *   eg-tg-pricey  — telegram post 80 000 ₽ (fresh)        → filtered by price
 *   eg-ig-cheap   — instagram reels 30 000 ₽ (fresh)      → filtered by platform
 *   eg-tg-stale   — telegram post 40 000 ₽ (8 months old) → filtered by freshness
 *
 * Both representations are seeded (placement_offer rows for the SQL filters +
 * the rolled placementOffers JSON the cards render), mirroring production
 * dual-write.
 */
async function main(): Promise<void> {
  const prisma = getPrisma();

  const passwordHash = await bcrypt.hash('e2e-password', 10);
  await prisma.user.upsert({
    where: { email: 'e2e@nosquare.local' },
    update: { passwordHash, role: 'admin' },
    create: { email: 'e2e@nosquare.local', passwordHash, role: 'admin' },
  });

  await prisma.featureFlag.upsert({
    where: { key: 'agency_sourcing' },
    update: { enabled: true },
    create: { key: 'agency_sourcing', enabled: true, description: 'e2e' },
  });

  const fresh = new Date();
  const stale = new Date(Date.now() - 240 * 24 * 60 * 60 * 1000);

  const profiles: Array<{
    channelId: string;
    platform: string;
    kind: string;
    price: number;
    capturedAt: Date;
  }> = [
    { channelId: 'eg-tg-cheap', platform: 'telegram', kind: 'post', price: 47000, capturedAt: fresh },
    { channelId: 'eg-tg-pricey', platform: 'telegram', kind: 'post', price: 80000, capturedAt: fresh },
    { channelId: 'eg-ig-cheap', platform: 'instagram', kind: 'reels', price: 30000, capturedAt: fresh },
    { channelId: 'eg-tg-stale', platform: 'telegram', kind: 'post', price: 40000, capturedAt: stale },
  ];

  for (const p of profiles) {
    const offerJson = {
      kind: p.kind,
      platform: p.platform,
      price: p.price,
      currency: 'RUB',
      attributes: [],
      confidence: 0.9,
      rawSnippet: `e2e ${p.channelId} ${p.price}`,
      rawPrice: String(p.price),
      sourceMessageId: null,
      extractedBy: 'rate_card_extractor',
      capturedAt: p.capturedAt.toISOString(),
    };
    const profile = await prisma.bloggerProfile.upsert({
      where: { channelId: p.channelId },
      update: { placementOffers: [offerJson] as never },
      create: {
        channelId: p.channelId,
        topics: ['e2e'],
        placementOffers: [offerJson] as never,
      },
    });
    const sourceDataPointId = `e2e_dp_${p.channelId}`;
    const exists = await prisma.placementOfferRow.findFirst({
      where: { profileId: profile.id, sourceDataPointId },
      select: { id: true },
    });
    if (!exists) {
      await prisma.placementOfferRow.create({
        data: {
          profileId: profile.id,
          platform: p.platform,
          kind: p.kind,
          priceMin: p.price,
          priceMax: p.price,
          priceRubMin: p.price,
          priceRubMax: p.price,
          fxRateUsed: 1,
          currency: 'RUB',
          identityKey: `${p.platform}|${p.kind}||||`,
          status: 'active',
          confidence: 0.9,
          rawSnippet: `e2e ${p.channelId} ${p.price}`,
          rawPrice: String(p.price),
          sourceDataPointId,
          capturedAt: p.capturedAt,
        },
      });
    }
  }

  console.log('[seed-e2e] done: admin e2e@nosquare.local / e2e-password, 4 profiles');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed-e2e] failed:', err);
    process.exit(1);
  });
