import { z } from 'zod';
import { PROFILE_FIELD_TTL_DAYS } from './profile-staleness.js';
import { decimalToNumber, type PlacementOfferRowLike } from './placement-offer-rows.js';

/**
 * Catalog offer-search semantics (catalog-sql-search D1). This module is the
 * SINGLE source of truth for «подходит ли профиль под фильтр» — defined as a
 * Prisma-free PURE predicate (packages/shared depends only on zod; @nosquare/db
 * depends on shared, so a Prisma builder here would invert the dependency).
 * The SQL compilation lives in apps/api (`offerFilterWhere`); a parity test
 * feeds the same fixtures through both.
 *
 * Composition rule: a profile matches when AT LEAST ONE of its `active` offer
 * rows satisfies ALL offer-level conditions together (per-offer AND, cross-
 * offer OR).
 */

export const CATALOG_SORTS = ['updated', 'price_asc', 'cpm_asc'] as const;
export type CatalogSort = (typeof CATALOG_SORTS)[number];

export const CatalogOfferFiltersZ = z.object({
  platform: z.string().trim().toLowerCase().optional(),
  kind: z.string().trim().toLowerCase().optional(),
  duration: z.string().trim().toLowerCase().optional(),
  /** Matches offers whose ₽-price lower bound fits: `priceRubMin <= max`. */
  priceRubMax: z.coerce.number().positive().optional(),
  cpmRubMax: z.coerce.number().positive().optional(),
  /** Only offers captured within the last N days. */
  offerFreshDays: z.coerce.number().int().positive().optional(),
  /** Only profiles having at least one active offer row. */
  hasOffers: z.coerce.boolean().optional(),
  sort: z.enum(CATALOG_SORTS).default('updated'),
});
export type CatalogOfferFilters = z.infer<typeof CatalogOfferFiltersZ>;

/** True when any OFFER-level condition is present (not just sort/hasOffers). */
export function hasOfferConditions(f: CatalogOfferFilters): boolean {
  return Boolean(
    f.platform || f.kind || f.duration || f.priceRubMax || f.cpmRubMax || f.offerFreshDays,
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Staleness TTL for offer prices = the rate-card freshness section. */
export const OFFER_STALE_AFTER_DAYS = PROFILE_FIELD_TTL_DAYS.rateCards;

/** Label one capturedAt as stale (older than the rate-card TTL). */
export function isOfferStale(capturedAt: Date | string, now: Date = new Date()): boolean {
  const ms = capturedAt instanceof Date ? capturedAt.getTime() : Date.parse(String(capturedAt));
  if (!Number.isFinite(ms)) return false;
  return now.getTime() - ms > OFFER_STALE_AFTER_DAYS * DAY_MS;
}

/**
 * The effective ₽-comparison price of a row, mirroring the matching semantics:
 * normalized `priceRubMin` when present, else the raw price for RUB rows, else
 * null (term-only / unnormalized fx — visible, outside ₽-comparisons).
 */
export function rowPriceRub(row: PlacementOfferRowLike): number | null {
  const rub = decimalToNumber(row.priceRubMin ?? null);
  if (rub !== null) return rub;
  if (row.currency.trim().toUpperCase() !== 'RUB') return null;
  return decimalToNumber(row.priceMin);
}

/** PURE per-offer predicate: does this row satisfy ALL offer-level conditions? */
export function offerMatchesFilters(
  row: PlacementOfferRowLike & { duration?: string | null },
  f: CatalogOfferFilters,
  now: Date = new Date(),
): boolean {
  if (row.status !== 'active') return false;
  if (f.platform && (row.platform ?? '').toLowerCase() !== f.platform) return false;
  if (f.kind && row.kind.toLowerCase() !== f.kind) return false;
  if (f.duration && (row.duration ?? '').toLowerCase() !== f.duration) return false;
  if (f.priceRubMax !== undefined) {
    const price = rowPriceRub(row);
    if (price === null || price > f.priceRubMax) return false;
  }
  if (f.cpmRubMax !== undefined) {
    const cpm = decimalToNumber(row.cpmRub ?? null);
    if (cpm === null || cpm > f.cpmRubMax) return false;
  }
  if (f.offerFreshDays !== undefined && isOfferStaleByDays(row.capturedAt, f.offerFreshDays, now)) {
    return false;
  }
  return true;
}

function isOfferStaleByDays(capturedAt: Date | string, days: number, now: Date): boolean {
  const ms = capturedAt instanceof Date ? capturedAt.getTime() : Date.parse(String(capturedAt));
  if (!Number.isFinite(ms)) return true;
  return now.getTime() - ms > days * DAY_MS;
}

/** PURE per-profile predicate: at least one active row satisfies everything. */
export function profileMatchesOfferFilters(
  rows: Array<PlacementOfferRowLike & { duration?: string | null }>,
  f: CatalogOfferFilters,
  now: Date = new Date(),
): boolean {
  if (f.hasOffers && !rows.some((r) => r.status === 'active')) return false;
  if (!hasOfferConditions(f)) return true;
  return rows.some((r) => offerMatchesFilters(r, f, now));
}

/**
 * Label offers with `stale` (older than the rate-card TTL) for list/detail/
 * compare responses — stale prices stay VISIBLE, never silently hidden.
 */
export function labelOfferStaleness<T extends { capturedAt?: string | null }>(
  offers: T[],
  now: Date = new Date(),
): Array<T & { stale: boolean }> {
  return offers.map((o) => ({
    ...o,
    stale: o.capturedAt ? isOfferStale(o.capturedAt, now) : false,
  }));
}

/**
 * Matching pre-cut inclusion predicate (catalog-sql-search D4) — the PURE
 * mirror of the SQL pre-cut, used by the superset-parity test. A profile is
 * included when ANY of:
 *   1. it has NO active offer rows (legacy `rateCards` fallback candidates —
 *      includes rows-only-low_confidence profiles, whose rolled
 *      `placementOffers` is empty so matching runs the legacy path);
 *   2. some active row's effective ₽-price fits the budget;
 *   3. some active row is PRICELESS in ₽ terms (term-only or unnormalized
 *      non-RUB) — the in-memory budget gate treats those as price-unknown and
 *      passes them.
 * Only the BUDGET is pre-cut: platform/kind from RU brief formats are fuzzy
 * (parseBriefPlacementWants) and not safely expressible in SQL.
 */
export function precutIncludesProfile(
  rows: PlacementOfferRowLike[],
  budget: number,
): boolean {
  const active = rows.filter((r) => r.status === 'active');
  if (active.length === 0) return true;
  return active.some((r) => {
    const price = rowPriceRub(r);
    return price === null || price <= budget;
  });
}
