import type { Prisma } from '@nosquare/db';
import { hasOfferConditions, type CatalogOfferFilters } from '@nosquare/shared';

/**
 * SQL compilation of the shared catalog-offer filter semantics (catalog-sql-
 * search D1). The pure predicate in `@nosquare/shared/catalog-offer-filters`
 * is the source of truth; this module translates it to Prisma `where`
 * fragments for BOTH consumers — the catalog list service and the matching
 * stage-1 pre-cut. Keep the two in lockstep: the shared parity test feeds the
 * same fixtures through the predicate and through these fragments' semantics.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Conditions for ONE active offer row satisfying ALL offer-level filters. */
export function offerFilterWhere(
  f: CatalogOfferFilters,
  now: Date = new Date(),
): Prisma.PlacementOfferRowWhereInput {
  const and: Prisma.PlacementOfferRowWhereInput[] = [{ status: 'active' }];
  if (f.platform) and.push({ platform: { equals: f.platform, mode: 'insensitive' } });
  if (f.kind) and.push({ kind: { equals: f.kind, mode: 'insensitive' } });
  if (f.duration) and.push({ duration: { equals: f.duration, mode: 'insensitive' } });
  if (f.priceRubMax !== undefined) {
    // Mirrors `rowPriceRub`: normalized ₽ bound, or the raw price for RUB rows
    // that predate normalization. Unnormalized non-RUB / term-only rows have
    // no ₽-price and do not satisfy a price cap.
    and.push({
      OR: [
        { priceRubMin: { lte: f.priceRubMax } },
        {
          priceRubMin: null,
          currency: { equals: 'RUB', mode: 'insensitive' },
          priceMin: { lte: f.priceRubMax },
        },
      ],
    });
  }
  if (f.cpmRubMax !== undefined) and.push({ cpmRub: { lte: f.cpmRubMax } });
  if (f.offerFreshDays !== undefined) {
    and.push({ capturedAt: { gte: new Date(now.getTime() - f.offerFreshDays * DAY_MS) } });
  }
  return { AND: and };
}

/** Profile-level `where`: at least one active row satisfies all conditions. */
export function profileOfferFilterWhere(
  f: CatalogOfferFilters,
  now: Date = new Date(),
): Prisma.BloggerProfileWhereInput {
  const and: Prisma.BloggerProfileWhereInput[] = [];
  if (f.hasOffers) and.push({ offerRows: { some: { status: 'active' } } });
  if (hasOfferConditions(f)) and.push({ offerRows: { some: offerFilterWhere(f, now) } });
  return and.length > 0 ? { AND: and } : {};
}

/**
 * Matching stage-1 pre-cut `where` (catalog-sql-search D4): SQL mirror of the
 * shared `precutIncludesProfile` predicate. ONLY the budget is expressible
 * safely; the result is a guaranteed SUPERSET of the in-memory shortlist:
 *   - profiles with no ACTIVE rows are always included (legacy rateCards
 *     fallback — covers low_confidence-only profiles too);
 *   - rows with a ₽-price ≤ budget pass;
 *   - PRICELESS rows pass (term-only, or non-RUB without a rate — the
 *     in-memory budget gate treats both as price-unknown).
 */
export function matchingPrecutWhere(budget: number): Prisma.BloggerProfileWhereInput {
  return {
    OR: [
      { offerRows: { none: { status: 'active' } } },
      {
        offerRows: {
          some: {
            status: 'active',
            OR: [
              { priceRubMin: { lte: budget } },
              // RUB raw fallback under budget.
              {
                priceRubMin: null,
                currency: { equals: 'RUB', mode: 'insensitive' },
                priceMin: { lte: budget },
              },
              // Priceless in ₽ terms: term-only RUB…
              {
                priceRubMin: null,
                currency: { equals: 'RUB', mode: 'insensitive' },
                priceMin: null,
              },
              // …or unnormalized non-RUB (no rate ⇒ outside ₽-comparisons).
              {
                priceRubMin: null,
                NOT: { currency: { equals: 'RUB', mode: 'insensitive' } },
              },
            ],
          },
        },
      },
    ],
  };
}
