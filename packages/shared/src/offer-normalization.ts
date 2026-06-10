import { decimalToNumber } from './placement-offer-rows.js';

/**
 * Pure offer normalization (price-normalization-v2): derive RUB-comparable
 * values + CPM for one placement-offer row from (a) the current exchange rate
 * and (b) a views basis. IO-free and replayable — the worker write path and the
 * `offer-renormalize` job both call this; raw columns are NEVER produced or
 * modified here, only the derived ones.
 *
 * Missing rate (non-RUB currency with no `exchange_rate` row) → all-null
 * normalization: the offer stays visible everywhere but does not participate
 * in RUB comparisons. We never normalize with an invented rate.
 */

export interface ExchangeRateLike {
  currency: string;
  rateToRub: unknown; // Prisma Decimal | number | string
  asOf: Date | string;
}

export type ViewsSource = 'post_insights' | 'profile_avg';

export interface ViewsBasisResolved {
  views: number;
  source: ViewsSource;
}

export interface NormalizedOfferFields {
  priceRubMin: number | null;
  priceRubMax: number | null;
  fxRateUsed: number | null;
  fxAsOf: Date | null;
  cpmRub: number | null;
  viewsBasis: number | null;
  viewsSource: ViewsSource | null;
}

export const ALL_NULL_NORMALIZATION: NormalizedOfferFields = {
  priceRubMin: null,
  priceRubMax: null,
  fxRateUsed: null,
  fxAsOf: null,
  cpmRub: null,
  viewsBasis: null,
  viewsSource: null,
};

/**
 * Kinds whose price is denominated by views — CPM is meaningful. `package`
 * (bundle total) and `other`/unknown kinds get null CPM regardless of views.
 */
export const CPM_ELIGIBLE_KINDS = new Set(['post', 'story', 'reels', 'shorts', 'video', 'integration']);

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function normalizeOffer(
  offer: { kind: string; currency: string; priceMin: number | null; priceMax: number | null },
  rate: ExchangeRateLike | null,
  views: ViewsBasisResolved | null,
): NormalizedOfferFields {
  const currency = offer.currency.trim().toUpperCase();
  let priceRubMin: number | null = null;
  let priceRubMax: number | null = null;
  let fxRateUsed: number | null = null;
  let fxAsOf: Date | null = null;

  if (currency === 'RUB') {
    priceRubMin = offer.priceMin;
    priceRubMax = offer.priceMax;
    fxRateUsed = 1;
  } else if (rate) {
    const r = decimalToNumber(rate.rateToRub);
    if (r !== null && r > 0) {
      priceRubMin = offer.priceMin === null ? null : round2(offer.priceMin * r);
      priceRubMax = offer.priceMax === null ? null : round2(offer.priceMax * r);
      fxRateUsed = r;
      fxAsOf = rate.asOf instanceof Date ? rate.asOf : new Date(rate.asOf);
    }
  }

  let cpmRub: number | null = null;
  let viewsBasis: number | null = null;
  let viewsSource: ViewsSource | null = null;
  if (
    priceRubMin !== null &&
    CPM_ELIGIBLE_KINDS.has(offer.kind.toLowerCase()) &&
    views &&
    views.views > 0
  ) {
    cpmRub = round2((priceRubMin / views.views) * 1000);
    viewsBasis = views.views;
    viewsSource = views.source;
  }

  return { priceRubMin, priceRubMax, fxRateUsed, fxAsOf, cpmRub, viewsBasis, viewsSource };
}

/** Minimal post-insight shape the views resolver needs. */
export interface ViewsInsightLike {
  platform: string;
  metrics: unknown; // Json — expects a numeric `views` field when present
  publishedAt?: Date | string | null;
  metricCapturedAt?: Date | string | null;
}

const toMs = (v: Date | string | null | undefined): number => {
  if (!v) return 0;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : 0;
};

function metricViews(metrics: unknown): number | null {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) return null;
  const v = (metrics as Record<string, unknown>)['views'];
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[\s,]/g, ''));
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

/**
 * Views denominator for CPM, in preference order:
 *   1. MEDIAN views of the newest ≤20 post insights on the offer's platform
 *      (median over mean: the catalog stores TOP posts, a mean would
 *      systematically understate CPM);
 *   2. profile-level `avgViews` (marked `profile_avg` so the UI can show «≈»);
 *   3. null — no CPM.
 */
export function resolveViewsBasis(
  insights: ViewsInsightLike[],
  platform: string | null,
  avgViews: number | null,
): ViewsBasisResolved | null {
  if (platform) {
    const views = insights
      .filter((i) => i.platform.toLowerCase() === platform.toLowerCase())
      .sort(
        (a, b) =>
          toMs(b.publishedAt ?? b.metricCapturedAt) - toMs(a.publishedAt ?? a.metricCapturedAt),
      )
      .slice(0, 20)
      .map((i) => metricViews(i.metrics))
      .filter((v): v is number => v !== null && v > 0)
      .sort((a, b) => a - b);
    if (views.length > 0) {
      const mid = Math.floor(views.length / 2);
      const median =
        views.length % 2 === 1 ? views[mid]! : Math.round((views[mid - 1]! + views[mid]!) / 2);
      return { views: median, source: 'post_insights' };
    }
  }
  if (avgViews !== null && avgViews > 0) return { views: avgViews, source: 'profile_avg' };
  return null;
}
