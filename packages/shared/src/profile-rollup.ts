import type { Audience, BloggerProfile, RateCard } from './schemas/blogger-profile.js';

/**
 * Deterministic blogger-profile roll-up (agency-sourcing-matching M5, task 5.3).
 *
 * Composes a `BloggerProfile`'s standardized fields from its granular
 * `ProfileDataPoint` rows. Pure + side-effect-free so it's trivially
 * unit-testable and re-derivable from provenance at any time (design D4).
 *
 * Composition rule per field: **latest high-confidence wins**. We sort the
 * contributing points by `(confidence desc, capturedAt desc)` and take the
 * first that yields a usable value. This means a freshly-captured high-
 * confidence fact supersedes an older/lower-confidence one without dropping
 * the older data point (it remains individually retrievable on the row).
 *
 * Field naming convention emitted by the extractor agents:
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
  'topics' | 'languages' | 'formats' | 'audience' | 'rateCards' | 'reach' | 'avgViews' | 'capturedAt'
>;

function toMillis(at: string | Date): number {
  const t = at instanceof Date ? at.getTime() : Date.parse(at);
  return Number.isFinite(t) ? t : 0;
}

/** Sort copy by (confidence desc, capturedAt desc). */
function byConfidenceThenRecency(points: RollupDataPoint[]): RollupDataPoint[] {
  return [...points].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return toMillis(b.capturedAt) - toMillis(a.capturedAt);
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
 * Compose the standardized profile fields from a set of data points.
 * Returns the rolled-up view; the caller persists it onto the BloggerProfile
 * row. `capturedAt` is the most recent contributing data point's timestamp
 * (the freshness of the rolled-up view), or null when there are no points.
 */
export function rollUpProfileFields(points: RollupDataPoint[]): RolledUpProfileFields {
  const byField = new Map<string, RollupDataPoint[]>();
  for (const p of points) {
    const arr = byField.get(p.field) ?? [];
    arr.push(p);
    byField.set(p.field, arr);
  }
  const groupsMatching = (pred: (field: string) => boolean): RollupDataPoint[] =>
    points.filter((p) => pred(p.field));

  // ── Rate cards: one per distinct format, latest-high-confidence price ──
  const rateFormats = new Set<string>();
  for (const f of byField.keys()) {
    const fmt = rateFormat(f);
    if (fmt) rateFormats.add(fmt);
  }
  const rateCards: RateCard[] = [];
  for (const fmt of [...rateFormats].sort()) {
    const pts = byField.get(`rate.${fmt}`) ?? [];
    const chosen = byConfidenceThenRecency(pts).find(
      (p) => toFiniteNumber(p.value) !== undefined,
    );
    const price = chosen ? toFiniteNumber(chosen.value) : undefined;
    if (price === undefined) continue;
    rateCards.push({
      format: fmt,
      price,
      currency: chosen?.unit && chosen.unit.trim() ? chosen.unit.trim() : 'RUB',
    });
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
  // Formats offered = explicit format fields ∪ formats we have a rate card for.
  const formatsFromFields = collectList((f) => f === 'formats' || f === 'format');
  const formats = [...formatsFromFields];
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
    reach: reach ?? null,
    avgViews: avgViews ?? null,
    capturedAt,
  };
}
