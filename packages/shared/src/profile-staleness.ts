/**
 * Per-section blogger-profile observation freshness
 * (blogger-profile-freshness change).
 *
 * Pure helpers that classify a `ProfileDataPoint` into one of the rolled-up
 * sections rendered by `rollUpProfileFields`, apply a category-specific TTL,
 * and produce a `{ stale, ageDays }` view per section.
 *
 * # Semantics
 *
 * The signal is **observation freshness**: per section, the age of the
 * newest *usable* contributing data point. It answers the operator-workflow
 * question "do we have a recent enough source for this section?".
 *
 * It is NOT the age of the *displayed rolled-up value*. `rollUpProfileFields`
 * chooses values by confidence-band-then-recency: an older high-confidence
 * point can beat a fresh low-confidence point. The displayed value may
 * therefore be older than this signal suggests. The drill-down list of
 * `dataPoints` shows the chosen-value provenance per point so operators
 * can audit. We do not re-implement rollup's confidence arbitration here —
 * doing so would double the surface area we keep in sync, and the
 * operator's "is there a recent observation?" question is best answered
 * by latest-usable-observation, not by the chosen value's age.
 *
 * Usability mirrors `rollUpProfileFields`'s value filters (numeric for
 * rate/reach/avgViews, non-empty share record for audience, non-empty
 * string list for topics/languages/formats), so a fresh-but-unusable point
 * (e.g. `rate.post = "договорная"`) does NOT mark the section fresh.
 *
 * Read-only, no DB or worker dependencies — workers, API, and the admin UI
 * can call this and arrive at the same answer. TTLs live here so retuning
 * is a one-line change shipped on the next deploy (no migration needed).
 */

export type ProfileFreshnessCategory =
  | 'rateCards'
  | 'audience'
  | 'topics'
  | 'languages'
  | 'formats'
  | 'reach'
  | 'avgViews';

/**
 * TTL per category. Rate cards / reach / avgViews shift quickly with platform
 * algorithm churn (≈ quarter). Audience demographics drift slower.
 * Topics / languages / formats are identity-level for the blogger and
 * effectively annual.
 */
export const PROFILE_FIELD_TTL_DAYS: Record<ProfileFreshnessCategory, number> = {
  rateCards: 90,
  reach: 90,
  avgViews: 90,
  audience: 180,
  topics: 365,
  languages: 365,
  formats: 365,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Map a raw `ProfileDataPoint.field` to its freshness category, mirroring
 * the field-naming convention `rollUpProfileFields` actually renders.
 * Returns `null` for unknown prefixes — an extractor shipping a new field
 * shape gets an explicit miss here rather than silently breaking the
 * staleness signal.
 *
 * Audience is intentionally narrow (`audience.geo|age|gender`): rollup
 * only renders these three dims today. A future `audience.income` would
 * not affect the displayed audience, so it should not affect freshness
 * either — when the extractor and rollup learn to render it, update this
 * classifier.
 */
export function classifyProfileField(field: string): ProfileFreshnessCategory | null {
  if (field.startsWith('rate.')) return 'rateCards';
  if (field === 'audience.geo' || field === 'audience.age' || field === 'audience.gender') {
    return 'audience';
  }
  if (field === 'reach' || field.startsWith('reach.')) return 'reach';
  if (
    field === 'views.avg' ||
    field === 'avg_views' ||
    field === 'views' ||
    field.startsWith('views.')
  ) {
    return 'avgViews';
  }
  if (field === 'topics' || field === 'topic') return 'topics';
  if (field === 'languages' || field === 'language') return 'languages';
  if (field === 'formats' || field === 'format') return 'formats';
  return null;
}

function toMillis(at: string | Date | null | undefined): number | null {
  if (at == null) return null;
  const t = at instanceof Date ? at.getTime() : Date.parse(at);
  return Number.isFinite(t) ? t : null;
}

/**
 * Value-shape checks that mirror `rollUpProfileFields`. Inlined rather than
 * imported to keep `profile-staleness` free of rollup-internal helpers and
 * to make the contract here a copy of what rollup actually accepts. If
 * rollup adds a new "usable" shape, mirror it here too.
 */
function isFiniteNumeric(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') {
    const n = Number(v.replace(/[\s,]/g, ''));
    return Number.isFinite(n);
  }
  return false;
}

function isNonEmptyShareRecord(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  for (const val of Object.values(v as Record<string, unknown>)) {
    if (isFiniteNumeric(val)) return true;
  }
  return false;
}

function isNonEmptyStringList(v: unknown): boolean {
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) {
    for (const x of v) {
      const s = typeof x === 'string' ? x.trim() : String(x ?? '').trim();
      if (s.length > 0) return true;
    }
  }
  return false;
}

/**
 * True when this data point's `value` would actually be picked up by
 * `rollUpProfileFields` for the given category. Used to keep section
 * freshness aligned with what's displayed.
 */
export function isContributingValue(
  category: ProfileFreshnessCategory,
  value: unknown,
): boolean {
  switch (category) {
    case 'rateCards':
    case 'reach':
    case 'avgViews':
      return isFiniteNumeric(value);
    case 'audience':
      return isNonEmptyShareRecord(value);
    case 'topics':
    case 'languages':
    case 'formats':
      return isNonEmptyStringList(value);
  }
}

/**
 * True when `capturedAt` is missing or older than the section's TTL. Unknown
 * fields (classifyProfileField returns null) are reported stale-by-default —
 * if we can't categorise a value we don't have a defensible "fresh" answer.
 *
 * Note: this helper does not check value-usability (it has no access to the
 * value). Use `computeProfileFreshness` for the per-section signal.
 */
export function isProfileFieldStale(
  field: string,
  capturedAt: string | Date | null | undefined,
  now: Date = new Date(),
): boolean {
  const category = classifyProfileField(field);
  if (!category) return true;
  const ts = toMillis(capturedAt);
  if (ts == null) return true;
  const ttlMs = PROFILE_FIELD_TTL_DAYS[category] * DAY_MS;
  return now.getTime() - ts > ttlMs;
}

export interface ProfileFreshnessSection {
  /** True when the section has no contributing timestamp or has expired. */
  stale: boolean;
  /** Whole days since the most-recent contributing timestamp; null if none. */
  ageDays: number | null;
}

export type ProfileFreshness = Record<ProfileFreshnessCategory, ProfileFreshnessSection>;

/** Subset of `ProfileDataPoint` the freshness pass needs. */
export interface FreshnessDataPoint {
  field: string;
  /** Raw extracted value — used to gate "did this point contribute?" */
  value: unknown;
  capturedAt: string | Date | null | undefined;
}

const ALL_CATEGORIES: ProfileFreshnessCategory[] = [
  'rateCards',
  'audience',
  'topics',
  'languages',
  'formats',
  'reach',
  'avgViews',
];

function ageDaysFromMillis(ts: number, nowMs: number): number {
  // Floor so an age "less than one day" reports 0, matching how operators
  // think about it ("today's data"). Negative ages (clock skew) become 0.
  return Math.max(0, Math.floor((nowMs - ts) / DAY_MS));
}

/**
 * Compose the per-section observation-freshness object the read API
 * returns.
 *
 * Per category: take the newest data point whose `field` classifies to
 * that category AND whose `value` would be picked up by
 * `rollUpProfileFields`'s value filters. If the category has no
 * contributing points, the section is `{ stale: true, ageDays: null }` —
 * we explicitly do NOT fall back to a profile-level timestamp, because a
 * single fresh point in one category would otherwise make every empty
 * section look fresh (codex review, R1).
 *
 * Cross-section contribution: rollup derives the displayed `formats`
 * union from explicit `formats|format` points AND from the rate cards
 * (each chosen rate.<format>'s format is added). To match, we count a
 * usable `rate.<format>` point toward both `rateCards` freshness AND
 * `formats` freshness — otherwise a profile whose only formats source is
 * the rate card itself would show fresh rate cards alongside permanently
 * stale formats, contradicting the rendered view.
 */
export function computeProfileFreshness(
  dataPoints: ReadonlyArray<FreshnessDataPoint>,
  now: Date = new Date(),
): ProfileFreshness {
  const nowMs = now.getTime();

  // Newest *contributing* data point per category. Unknown fields and
  // unusable values are ignored.
  const newestByCategory: Partial<Record<ProfileFreshnessCategory, number>> = {};
  const bump = (cat: ProfileFreshnessCategory, ms: number): void => {
    const current = newestByCategory[cat];
    if (current === undefined || ms > current) newestByCategory[cat] = ms;
  };

  for (const dp of dataPoints) {
    const cat = classifyProfileField(dp.field);
    if (!cat) continue;
    if (!isContributingValue(cat, dp.value)) continue;
    const ms = toMillis(dp.capturedAt);
    if (ms == null) continue;
    bump(cat, ms);
    // Rate cards also contribute to the displayed formats union.
    if (cat === 'rateCards') bump('formats', ms);
  }

  const out = {} as ProfileFreshness;
  for (const cat of ALL_CATEGORIES) {
    const ts = newestByCategory[cat];
    if (ts === undefined) {
      out[cat] = { stale: true, ageDays: null };
      continue;
    }
    const ttlMs = PROFILE_FIELD_TTL_DAYS[cat] * DAY_MS;
    out[cat] = {
      stale: nowMs - ts > ttlMs,
      ageDays: ageDaysFromMillis(ts, nowMs),
    };
  }
  return out;
}
