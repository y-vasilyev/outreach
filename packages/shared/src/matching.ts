import type { AdBrief } from './schemas/matching.js';
import type { Audience, BloggerProfile, RateCard } from './schemas/blogger-profile.js';

/**
 * Pure blogger-matching engine (agency-sourcing-matching M7, design D6).
 *
 * Two-stage filter→score over the catalog, kept side-effect-free so it's
 * trivially unit-testable and deterministic:
 *
 *   1. `prefilter`  — cheap deterministic exclusion: a profile must have at
 *      least one matchable topic / geo / format and (when the brief carries a
 *      budget) a relevant rate card that fits the budget. Clearly-irrelevant
 *      profiles drop out before any scoring.
 *   2. `scoreProfile` — produces a score in [0,1] from topic/geo/format/budget
 *      sub-scores plus a human-readable rationale.
 *   3. `rankProfiles` — prefilters, scores, and orders the survivors.
 *
 * The optional LLM re-rank (BloggerMatcher agent) operates on the top N of the
 * deterministic ranking; the engine here never calls an LLM.
 */

/** A profile narrowed to the fields matching reads (subset of BloggerProfile). */
export type MatchableProfile = Pick<
  BloggerProfile,
  'id' | 'topics' | 'languages' | 'formats' | 'audience' | 'rateCards' | 'reach' | 'avgViews'
>;

export interface ScoredProfile {
  profileId: string;
  score: number;
  rationale: string;
}

/** Weights for the deterministic sub-scores; sum is normalised at use. */
const WEIGHTS = {
  topic: 0.4,
  geo: 0.25,
  format: 0.2,
  budget: 0.15,
} as const;

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function tokenize(s: string): string[] {
  return norm(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
}

/** Does `haystack` (a token set) contain `needle` (substring-aware)? */
function fuzzyHas(haystackTokens: Set<string>, needle: string): boolean {
  const n = norm(needle);
  if (!n) return false;
  if (haystackTokens.has(n)) return true;
  // substring either direction (e.g. brief "крипта" vs profile topic "криптовалюта")
  for (const t of haystackTokens) {
    if (t.includes(n) || n.includes(t)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Topic                                                              */
/* ------------------------------------------------------------------ */

export function topicScore(brief: AdBrief, profile: MatchableProfile): { score: number; matched: string[] } {
  const briefTerms = [brief.topic, ...tokenize(brief.topic)].filter(Boolean);
  if (briefTerms.length === 0) return { score: 0, matched: [] };
  const profileTokens = new Set<string>();
  for (const t of profile.topics) {
    profileTokens.add(norm(t));
    for (const tok of tokenize(t)) profileTokens.add(tok);
  }
  const matched: string[] = [];
  for (const term of new Set(briefTerms.map(norm))) {
    if (fuzzyHas(profileTokens, term)) matched.push(term);
  }
  // Whole-topic match dominates; token overlap contributes partially.
  const wholeMatch = profile.topics.some((t) => fuzzyHas(new Set([norm(brief.topic)]), t) || fuzzyHas(profileTokens, brief.topic));
  const tokenTerms = tokenize(brief.topic);
  const ratio = tokenTerms.length > 0
    ? tokenTerms.filter((t) => fuzzyHas(profileTokens, t)).length / tokenTerms.length
    : 0;
  const score = wholeMatch ? Math.max(0.7, ratio) : ratio * 0.8;
  return { score: Math.min(1, score), matched };
}

/* ------------------------------------------------------------------ */
/* Geo                                                                */
/* ------------------------------------------------------------------ */

function profileGeoKeys(audience: Audience): Set<string> {
  const out = new Set<string>();
  const geo = (audience as { geo?: Record<string, number> } | undefined)?.geo ?? {};
  for (const k of Object.keys(geo)) {
    out.add(norm(k));
    for (const tok of tokenize(k)) out.add(tok);
  }
  return out;
}

export function geoScore(brief: AdBrief, profile: MatchableProfile): { score: number; matched: string[]; applicable: boolean } {
  if (brief.geo.length === 0) return { score: 1, matched: [], applicable: false };
  const keys = profileGeoKeys(profile.audience);
  if (keys.size === 0) return { score: 0, matched: [], applicable: true };
  const matched = brief.geo.filter((g) => fuzzyHas(keys, g)).map(norm);
  const score = matched.length / brief.geo.length;
  return { score, matched, applicable: true };
}

/* ------------------------------------------------------------------ */
/* Format                                                             */
/* ------------------------------------------------------------------ */

function profileFormatKeys(profile: MatchableProfile): Set<string> {
  const out = new Set<string>();
  for (const f of profile.formats) {
    out.add(norm(f));
    for (const tok of tokenize(f)) out.add(tok);
  }
  for (const rc of profile.rateCards) {
    out.add(norm(rc.format));
    for (const tok of tokenize(rc.format)) out.add(tok);
  }
  return out;
}

export function formatScore(brief: AdBrief, profile: MatchableProfile): { score: number; matched: string[]; applicable: boolean } {
  if (brief.formats.length === 0) return { score: 1, matched: [], applicable: false };
  const keys = profileFormatKeys(profile);
  if (keys.size === 0) return { score: 0, matched: [], applicable: true };
  const matched = brief.formats.filter((f) => fuzzyHas(keys, f)).map(norm);
  const score = matched.length / brief.formats.length;
  return { score, matched, applicable: true };
}

/* ------------------------------------------------------------------ */
/* Budget                                                             */
/* ------------------------------------------------------------------ */

/**
 * Rate cards relevant to the brief: those whose format the brief asked for.
 * When the brief specifies formats but the profile has NO rate card for any of
 * them, this returns an empty list — NOT all rate cards (S5). Budgeting against
 * an unrelated format's price would wrongly include or exclude a profile; the
 * format-relevance check (not budget) governs that case. When the brief
 * specifies no formats, all rate cards are relevant.
 */
export function relevantRates(brief: AdBrief, profile: MatchableProfile): RateCard[] {
  if (brief.formats.length === 0) return profile.rateCards;
  const wanted = new Set(brief.formats.map(norm));
  return profile.rateCards.filter((rc) => {
    const fk = new Set<string>([norm(rc.format), ...tokenize(rc.format)]);
    for (const w of wanted) if (fuzzyHas(fk, w)) return true;
    return false;
  });
}

export function minRelevantRate(brief: AdBrief, profile: MatchableProfile): number | undefined {
  const rates = relevantRates(brief, profile)
    .map((rc) => rc.price)
    .filter((p) => typeof p === 'number' && Number.isFinite(p) && p > 0);
  return rates.length > 0 ? Math.min(...rates) : undefined;
}

export function budgetScore(
  brief: AdBrief,
  profile: MatchableProfile,
): { score: number; applicable: boolean; fits: boolean; minRate?: number } {
  if (brief.budget === null || brief.budget === undefined) {
    return { score: 0.5, applicable: false, fits: true };
  }
  const minRate = minRelevantRate(brief, profile);
  if (minRate === undefined) {
    // Budget set but no known rate card → can't confirm fit; neutral-low.
    return { score: 0.5, applicable: true, fits: true };
  }
  if (minRate > brief.budget) {
    return { score: 0, applicable: true, fits: false, minRate };
  }
  // Cheaper relative to budget scores higher (more headroom), capped.
  const ratio = minRate / brief.budget; // (0, 1]
  const score = Math.max(0.5, 1 - ratio * 0.5); // 0.5..1
  return { score, applicable: true, fits: true, minRate };
}

/* ------------------------------------------------------------------ */
/* Prefilter                                                          */
/* ------------------------------------------------------------------ */

export interface PrefilterReason {
  profileId: string;
  reason: string;
}

/**
 * Deterministic exclusion. A profile is excluded when, for any dimension the
 * brief constrains, it has NO overlap at all — or when its cheapest relevant
 * rate exceeds the budget. Dimensions the brief leaves empty don't constrain.
 */
export function isShortlisted(brief: AdBrief, profile: MatchableProfile): { ok: boolean; reason?: string } {
  // Topic: brief always has a topic. Require at least a partial overlap.
  const topic = topicScore(brief, profile);
  if (topic.score <= 0) return { ok: false, reason: `no topic overlap (brief="${brief.topic}")` };

  if (brief.geo.length > 0) {
    const geo = geoScore(brief, profile);
    if (geo.applicable && geo.score <= 0) {
      return { ok: false, reason: `geo mismatch (brief=${brief.geo.join('/')})` };
    }
  }

  if (brief.formats.length > 0) {
    const fmt = formatScore(brief, profile);
    if (fmt.applicable && fmt.score <= 0) {
      return { ok: false, reason: `format unavailable (brief=${brief.formats.join('/')})` };
    }
  }

  if (brief.budget !== null && brief.budget !== undefined) {
    const budget = budgetScore(brief, profile);
    if (budget.applicable && !budget.fits) {
      return {
        ok: false,
        reason: `over budget (min rate ${budget.minRate} > budget ${brief.budget})`,
      };
    }
  }

  return { ok: true };
}

export function prefilter(brief: AdBrief, profiles: MatchableProfile[]): MatchableProfile[] {
  return profiles.filter((p) => isShortlisted(brief, p).ok);
}

/* ------------------------------------------------------------------ */
/* Score + rationale                                                  */
/* ------------------------------------------------------------------ */

export function scoreProfile(brief: AdBrief, profile: MatchableProfile): ScoredProfile {
  const topic = topicScore(brief, profile);
  const geo = geoScore(brief, profile);
  const fmt = formatScore(brief, profile);
  const budget = budgetScore(brief, profile);

  const raw =
    WEIGHTS.topic * topic.score +
    WEIGHTS.geo * geo.score +
    WEIGHTS.format * fmt.score +
    WEIGHTS.budget * budget.score;
  // WEIGHTS sum to 1, so raw is already in [0,1].
  const score = Math.max(0, Math.min(1, raw));

  const parts: string[] = [];
  parts.push(
    topic.matched.length > 0
      ? `тема: совпадение по ${topic.matched.join(', ')}`
      : `тема: слабое совпадение с «${brief.topic}»`,
  );
  if (geo.applicable) {
    parts.push(geo.matched.length > 0 ? `гео: ${geo.matched.join(', ')}` : 'гео: нет пересечения');
  }
  if (fmt.applicable) {
    parts.push(fmt.matched.length > 0 ? `форматы: ${fmt.matched.join(', ')}` : 'форматы: не предлагает запрошенное');
  }
  if (budget.applicable) {
    if (budget.minRate !== undefined) {
      parts.push(
        budget.fits
          ? `бюджет: прайс ${budget.minRate} ≤ ${brief.budget} (вписывается)`
          : `бюджет: прайс ${budget.minRate} > ${brief.budget} (превышает)`,
      );
    } else {
      parts.push('бюджет: прайс неизвестен');
    }
  }
  parts.push(`итог ${(score * 100).toFixed(0)}%`);

  return { profileId: profile.id, score, rationale: parts.join('; ') };
}

/**
 * Prefilter → score → order. Ties broken by reach (higher first) then id for
 * determinism. Returns scored survivors only.
 */
export function rankProfiles(brief: AdBrief, profiles: MatchableProfile[]): ScoredProfile[] {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const shortlisted = prefilter(brief, profiles);
  const scored = shortlisted.map((p) => scoreProfile(brief, p));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ra = byId.get(a.profileId)?.reach ?? 0;
    const rb = byId.get(b.profileId)?.reach ?? 0;
    if (rb !== ra) return rb - ra;
    return a.profileId.localeCompare(b.profileId);
  });
  return scored;
}
