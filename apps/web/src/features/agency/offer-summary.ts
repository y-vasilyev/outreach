import type { PlacementOffer } from './types';

/**
 * Aggregated «цена от / CPM от» over a profile's structured offers
 * (decision-ux). Pure module so the rules are unit-testable.
 *
 * Rules:
 * - Price candidate: ₽-normalized `priceRubMin` when present; a raw RUB
 *   `price_min ?? price` otherwise. Non-RUB offers without normalization are
 *   excluded (comparing raw currencies would lie) — the tile tooltip says
 *   «по RUB-нормализованным офферам».
 * - Minimum over non-stale offers first; when only stale offers carry a
 *   price, fall back to them and mark the result stale (prices are never
 *   hidden, only marked — catalog-sql-search policy).
 */
export interface OfferPriceSummary {
  priceFromRub: number | null;
  priceStale: boolean;
  cpmFromRub: number | null;
  /** CPM of the picked offer is based on profile avgViews, not offer views. */
  cpmApprox: boolean;
  cpmStale: boolean;
  /** Per-platform price floor for the tooltip breakdown (null = без платформы). */
  perPlatform: Array<{ platform: string | null; priceFromRub: number | null; stale: boolean }>;
}

/** Currency tags are not normalized upstream («rub» vs «RUB») — match catalog/matching. */
export function isRubCurrency(currency: string | null | undefined): boolean {
  return (currency ?? '').trim().toUpperCase() === 'RUB';
}

function candidatePriceRub(o: PlacementOffer): number | null {
  const normalized = o.normalized?.priceRubMin;
  if (normalized != null) return normalized;
  if (isRubCurrency(o.currency)) return o.price_min ?? o.price ?? null;
  return null;
}

function minBy<T>(pool: T[], key: (item: T) => number | null): { item: T; value: number } | null {
  let best: { item: T; value: number } | null = null;
  for (const item of pool) {
    const value = key(item);
    if (value == null) continue;
    if (!best || value < best.value) best = { item, value };
  }
  return best;
}

function pickMin(
  offers: PlacementOffer[],
  key: (o: PlacementOffer) => number | null,
): { offer: PlacementOffer; value: number; stale: boolean } | null {
  const fresh = minBy(offers.filter((o) => !o.stale), key);
  if (fresh) return { offer: fresh.item, value: fresh.value, stale: false };
  const any = minBy(offers, key);
  return any ? { offer: any.item, value: any.value, stale: true } : null;
}

export function summarizeOffers(offers: PlacementOffer[]): OfferPriceSummary {
  const price = pickMin(offers, candidatePriceRub);
  const cpm = pickMin(offers, (o) => o.normalized?.cpmRub ?? null);

  const platforms = new Map<string | null, PlacementOffer[]>();
  for (const o of offers) {
    const k = o.platform ?? null;
    platforms.set(k, [...(platforms.get(k) ?? []), o]);
  }
  const perPlatform = [...platforms.entries()]
    .map(([platform, group]) => {
      const min = pickMin(group, candidatePriceRub);
      return { platform, priceFromRub: min?.value ?? null, stale: min?.stale ?? false };
    })
    .filter((p) => p.priceFromRub != null)
    .sort((a, b) => {
      if (a.platform === null) return 1;
      if (b.platform === null) return -1;
      return a.platform.localeCompare(b.platform);
    });

  return {
    priceFromRub: price?.value ?? null,
    priceStale: price?.stale ?? false,
    cpmFromRub: cpm?.value ?? null,
    cpmApprox: cpm?.offer.normalized?.viewsSource === 'profile_avg',
    cpmStale: cpm?.stale ?? false,
    perPlatform,
  };
}
