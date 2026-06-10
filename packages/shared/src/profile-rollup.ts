import {
  PlacementOfferZ,
  type PlacementOffer,
} from './schemas/placement-offer.js';
import {
  derivePlacementFormatKey,
  offerIdentityKey,
  placementOffersToFormats,
  placementOffersToRateCards,
} from './placement-offers.js';
import type {
  Audience,
  BloggerProfile,
  PlatformAudienceEntry,
  RateCard,
} from './schemas/blogger-profile.js';

/**
 * Deterministic blogger-profile roll-up (agency-sourcing-matching M5, task 5.3).
 *
 * Composes a `BloggerProfile`'s standardized fields from its granular
 * `ProfileDataPoint` rows. Pure + side-effect-free so it's trivially
 * unit-testable and re-derivable from provenance at any time (design D4).
 *
 * Composition rule per field: **fresh-within-band, else higher confidence**.
 * When two points' confidences are close (|Δconfidence| ≤ CONFIDENCE_BAND) we
 * prefer the more recently captured one — a fresh fact of comparable certainty
 * should supersede a stale one. Outside that band, the higher-confidence point
 * wins regardless of age. The older data point is never dropped (it remains
 * individually retrievable on its row). This avoids a stale high-confidence
 * value beating a slightly-less-confident fresh value (S2).
 *
 * Field naming convention emitted by the extractor agents:
 *   - `placement.offer`            → structured PlacementOffer (entity-style)
 *   - `rate.<format>`              → rate card entries (value = numeric price)
 *   - `reach.<format>` / `reach`   → reach (numeric)
 *   - `views.avg` / `avg_views`    → average views (numeric)
 *   - `audience.geo`               → geo distribution (record label→share)
 *   - `audience.age`               → age distribution
 *   - `audience.gender`            → gender distribution
 *   - `topics` / `topic`           → topic (string or string[])
 *   - `languages` / `language`     → language (string or string[])
 *   - `format` / `formats`         → offered format (string or string[])
 */

/** Minimal data-point shape the roll-up needs (a subset of ProfileDataPoint). */
export interface RollupDataPoint {
  field: string;
  value: unknown;
  unit?: string | null;
  confidence: number;
  capturedAt: string | Date;
}

export type RolledUpProfileFields = Pick<
  BloggerProfile,
  | 'topics'
  | 'languages'
  | 'formats'
  | 'audience'
  | 'rateCards'
  | 'placementOffers'
  | 'platformAudience'
  | 'reach'
  | 'avgViews'
  | 'capturedAt'
>;

function toMillis(at: string | Date): number {
  const t = at instanceof Date ? at.getTime() : Date.parse(at);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Confidence band within which freshness wins. Two points whose confidences
 * differ by ≤ this are treated as "comparably certain", so the more recent one
 * is preferred; beyond it, higher confidence dominates.
 */
export const CONFIDENCE_BAND = 0.15;

/**
 * Confidence floor for the comparable commercial views (harden-reply-extraction
 * D4). Facts below this are excluded from `placementOffers` AND from the legacy
 * `rateCards`/`formats` derived for compatibility, so a garbled low-confidence
 * offer cannot pollute search/compare via either path. The underlying data
 * points are never dropped — they remain individually retrievable (needs-review)
 * and HUD/observation freshness still counts them.
 */
export const PLACEMENT_OFFER_CONFIDENCE_FLOOR = 0.2;

/**
 * Sort copy so the best (first) is the freshest within a confidence band, else
 * the highest confidence. Concretely: when |Δconfidence| ≤ CONFIDENCE_BAND,
 * order by capturedAt desc (fresh wins); otherwise by confidence desc. Ties in
 * the chosen key fall back to the other key for determinism.
 */
function byConfidenceThenRecency(points: RollupDataPoint[]): RollupDataPoint[] {
  return [...points].sort((a, b) => {
    const sameBand = Math.abs(a.confidence - b.confidence) <= CONFIDENCE_BAND;
    if (sameBand) {
      const dt = toMillis(b.capturedAt) - toMillis(a.capturedAt);
      if (dt !== 0) return dt;
      return b.confidence - a.confidence;
    }
    return b.confidence - a.confidence;
  });
}

function toFiniteNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[\s,]/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function toStringList(v: unknown): string[] {
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) {
    return v
      .map((x) => (typeof x === 'string' ? x.trim() : String(x ?? '').trim()))
      .filter((s) => s.length > 0);
  }
  return [];
}

/** Coerce a value to a record<string, number> (audience distribution). */
function toShareRecord(v: unknown): Record<string, number> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const n = toFiniteNumber(val);
    if (n !== undefined) out[k] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** First usable mapped value from points sorted by latest-high-confidence. */
function firstUsable<T>(
  points: RollupDataPoint[],
  map: (p: RollupDataPoint) => T | undefined,
): T | undefined {
  for (const p of byConfidenceThenRecency(points)) {
    const mapped = map(p);
    if (mapped !== undefined) return mapped;
  }
  return undefined;
}

function rateFormat(field: string): string | undefined {
  const m = /^rate\.(.+)$/.exec(field);
  return m ? m[1] : undefined;
}

/**
 * Field name the extractor/persistence layer (Section 2) writes structured
 * placement offers under: one `ProfileDataPoint` row per offer, `value` a
 * validated `PlacementOffer` JSON object.
 */
const PLACEMENT_OFFER_FIELD = 'placement.offer';

/**
 * A stored placement offer plus the timestamp it was captured at, used to
 * choose best-by-confidence-then-recency across messages.
 */
interface CollectedOffer {
  offer: PlacementOffer;
  capturedMs: number;
}

/**
 * Stable identity for an offer: two offers with the same platform/kind/duration/
 * price/currency/snippet are the *same* offer (e.g. re-quoted in two messages).
 * A day post vs a month post differ on `duration`, so they never collapse.
 * `tariff_name`/`slot` are part of the identity too (placement-representation-v2)
 * so two SAME-price slots of one tariff stay distinct without touching the
 * derived `rate.<format>` key.
 */
function offerDedupeKey(offer: PlacementOffer): string {
  // Delegates to the shared identity helper (placement-offer-table D5) so the
  // worker write path, this roll-up, and the backfill agree on «which product
  // is this». The dedupe key = identity + price/currency/rawSnippet — the
  // joined output is byte-identical to the previous inline implementation.
  return [
    offerIdentityKey(offer),
    offer.price ?? '',
    (offer.currency ?? '').toLowerCase(),
    offer.rawSnippet.trim(),
  ].join('|');
}

/**
 * Roll up `placement.offer` data points into the deduped list of structured
 * offers. Invalid values are skipped (provenance on the row is the audit trail).
 * Within identical identity keys we keep the highest-confidence, then most
 * recent offer; distinct offers (e.g. day vs month post) are all preserved.
 * Provenance already lives on each `PlacementOffer` (sourceMessageId/rawSnippet/
 * capturedAt); we keep the row's `capturedAt` as a tie-break fallback when the
 * offer itself carries none.
 */
function collectPlacementOffers(points: RollupDataPoint[]): PlacementOffer[] {
  const best = new Map<string, CollectedOffer>();
  const order: string[] = [];
  for (const p of points) {
    if (p.field !== PLACEMENT_OFFER_FIELD) continue;
    const parsed = PlacementOfferZ.safeParse(p.value);
    if (!parsed.success) continue;
    const offer = parsed.data;
    // Comparable-view confidence floor: sub-floor offers stay on their data-point
    // rows (provenance/needs-review) but do not enter the rolled-up list.
    if (offer.confidence < PLACEMENT_OFFER_CONFIDENCE_FLOOR) continue;
    // Keep the offer's own capturedAt provenance; backfill from the row when
    // the stored offer didn't carry one (older writes).
    if (!offer.capturedAt) {
      const at = p.capturedAt;
      offer.capturedAt = at instanceof Date ? at.toISOString() : String(at);
    }
    const capturedMs = offer.capturedAt ? toMillis(offer.capturedAt) : toMillis(p.capturedAt);
    const key = offerDedupeKey(offer);
    const existing = best.get(key);
    if (!existing) {
      best.set(key, { offer, capturedMs });
      order.push(key);
      continue;
    }
    // Higher confidence wins; tie → more recent.
    const better =
      offer.confidence > existing.offer.confidence ||
      (offer.confidence === existing.offer.confidence && capturedMs > existing.capturedMs);
    if (better) best.set(key, { offer, capturedMs });
  }
  return order.map((k) => best.get(k)!.offer);
}

/**
 * Compose the standardized profile fields from a set of data points.
 * Returns the rolled-up view; the caller persists it onto the BloggerProfile
 * row. `capturedAt` is the most recent contributing data point's timestamp
 * (the freshness of the rolled-up view), or null when there are no points.
 */
export function rollUpProfileFields(
  points: RollupDataPoint[],
  opts?: {
    /**
     * Pre-composed placement offers (placement-offer-table): when the caller
     * composed them from `placement_offer` ROWS (`composeOffersFromRows`),
     * pass them here and the legacy compose-from-data-points path is skipped.
     * Omit for the legacy fallback (profiles with no offer rows yet).
     */
    placementOffers?: PlacementOffer[];
  },
): RolledUpProfileFields {
  const byField = new Map<string, RollupDataPoint[]>();
  for (const p of points) {
    const arr = byField.get(p.field) ?? [];
    arr.push(p);
    byField.set(p.field, arr);
  }
  const groupsMatching = (pred: (field: string) => boolean): RollupDataPoint[] =>
    points.filter((p) => pred(p.field));

  // ── Structured placement offers (entity-style-rate-cards). Source of truth
  // for commercial terms when present; legacy rateCards/formats are derived
  // from these and merged with the legacy `rate.*`-derived ones below. ──
  const placementOffers = opts?.placementOffers ?? collectPlacementOffers(points);

  // ── Legacy rate cards: one per distinct `rate.<format>`, latest-high-
  // confidence price ──
  const rateFormats = new Set<string>();
  for (const f of byField.keys()) {
    const fmt = rateFormat(f);
    if (fmt) rateFormats.add(fmt);
  }
  const legacyRateCards: RateCard[] = [];
  for (const fmt of [...rateFormats].sort()) {
    const pts = byField.get(`rate.${fmt}`) ?? [];
    const chosen = byConfidenceThenRecency(pts).find(
      // Same comparable-view floor as structured offers, so a sub-floor fact
      // cannot leak back into the catalog via the legacy rate-card path.
      (p) => toFiniteNumber(p.value) !== undefined && p.confidence >= PLACEMENT_OFFER_CONFIDENCE_FLOOR,
    );
    const price = chosen ? toFiniteNumber(chosen.value) : undefined;
    if (price === undefined) continue;
    legacyRateCards.push({
      format: fmt,
      price,
      currency: chosen?.unit && chosen.unit.trim() ? chosen.unit.trim() : 'RUB',
    });
  }

  // ── Merge precedence: structured offers win over a legacy `rate.<fmt>` that
  // maps to the SAME derived format key, but distinct legacy cards with no
  // structured equivalent are preserved. Two distinct structured offers (day vs
  // month post) yield two cards (placementOffersToRateCards keeps them apart). ──
  const structuredRateCards = placementOffersToRateCards(placementOffers);
  const structuredFormatKeys = new Set<string>();
  for (const offer of placementOffers) structuredFormatKeys.add(derivePlacementFormatKey(offer));
  const rateCards: RateCard[] = [...structuredRateCards];
  for (const legacy of legacyRateCards) {
    if (structuredFormatKeys.has(legacy.format)) continue;
    rateCards.push(legacy);
  }

  // ── Reach: prefer the bare `reach` field, else any reach.<x> ──
  const reachPts = groupsMatching((f) => f === 'reach' || f.startsWith('reach.'));
  const reach = firstUsable(reachPts, (p) => {
    const n = toFiniteNumber(p.value);
    return n !== undefined ? Math.round(n) : undefined;
  });

  // ── Average views ──
  const viewsPts = groupsMatching(
    (f) => f === 'views.avg' || f === 'avg_views' || f === 'views' || f.startsWith('views.'),
  );
  const avgViews = firstUsable(viewsPts, (p) => {
    const n = toFiniteNumber(p.value);
    return n !== undefined ? Math.round(n) : undefined;
  });

  // ── Audience distributions ──
  const audience: Audience = {};
  const geo = firstUsable(
    groupsMatching((f) => f === 'audience.geo'),
    (p) => toShareRecord(p.value),
  );
  const age = firstUsable(
    groupsMatching((f) => f === 'audience.age'),
    (p) => toShareRecord(p.value),
  );
  const gender = firstUsable(
    groupsMatching((f) => f === 'audience.gender'),
    (p) => toShareRecord(p.value),
  );
  if (geo) audience.geo = geo;
  if (age) audience.age = age;
  if (gender) audience.gender = gender;

  // ── Per-platform audience (placement-representation-v2): one entry per
  // platform, from `audience.subscribers.<platform>` points, latest-high-
  // confidence per platform. Distinct from the scalar `reach`. ──
  const platformAudience: PlatformAudienceEntry[] = [];
  const subsByPlatform = new Map<string, RollupDataPoint[]>();
  for (const p of points) {
    const m = /^audience\.subscribers\.([a-z0-9_]+)$/.exec(p.field);
    if (!m) continue;
    const platform = m[1]!;
    const arr = subsByPlatform.get(platform) ?? [];
    arr.push(p);
    subsByPlatform.set(platform, arr);
  }
  for (const [platform, pts] of [...subsByPlatform.entries()].sort()) {
    const chosen = byConfidenceThenRecency(pts).find((p) => toFiniteNumber(p.value) !== undefined);
    const subscribers = chosen ? toFiniteNumber(chosen.value) : undefined;
    if (subscribers === undefined) continue;
    const at = chosen!.capturedAt;
    platformAudience.push({
      platform,
      subscribers: Math.round(subscribers),
      source: 'reply',
      capturedAt: at instanceof Date ? at.toISOString() : String(at),
    });
  }

  // ── Topics / languages / formats: union of all values (these accumulate
  // rather than overwrite — a blogger genuinely has multiple). Deduped,
  // order-stable by first appearance in latest-high-confidence order. ──
  const collectList = (pred: (f: string) => boolean): string[] => {
    const seen: string[] = [];
    for (const p of byConfidenceThenRecency(groupsMatching(pred))) {
      for (const s of toStringList(p.value)) {
        if (!seen.includes(s)) seen.push(s);
      }
    }
    return seen;
  };
  const topics = collectList((f) => f === 'topics' || f === 'topic');
  const languages = collectList((f) => f === 'languages' || f === 'language');
  // Formats offered = explicit format fields ∪ structured-offer formats ∪
  // formats we have a (merged) rate card for. Structured offers contribute even
  // when price-less (a term-only offer still describes an offered format).
  const formatsFromFields = collectList((f) => f === 'formats' || f === 'format');
  const formats = [...formatsFromFields];
  for (const f of placementOffersToFormats(placementOffers)) {
    if (!formats.includes(f)) formats.push(f);
  }
  for (const rc of rateCards) {
    if (!formats.includes(rc.format)) formats.push(rc.format);
  }

  // ── capturedAt: freshness of the rolled-up view = most recent point. ──
  let capturedAt: string | null = null;
  if (points.length > 0) {
    const newest = points.reduce((acc, p) =>
      toMillis(p.capturedAt) > toMillis(acc.capturedAt) ? p : acc,
    );
    const at = newest.capturedAt;
    capturedAt = at instanceof Date ? at.toISOString() : new Date(toMillis(at)).toISOString();
  }

  return {
    topics,
    languages,
    formats,
    audience,
    rateCards,
    placementOffers,
    platformAudience,
    reach: reach ?? null,
    avgViews: avgViews ?? null,
    capturedAt,
  };
}
